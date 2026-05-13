import { chromium, Browser, Page } from "playwright";
import * as cheerio from "cheerio";
import { ProviderScraperConfig, Provider } from "@prisma/client";
import { parsePrice, cleanProductName } from "../utils/index";
import { decrypt } from "../utils/crypto";

export interface ScrapedProduct {
  sku: string | null;
  name: string;
  description: string | null;
  wholesalePrice: number | null;
  oldPrice: number | null;
  stock: string | null;
  category: string | null;
  brand: string | null;
  productUrl: string | null;
  imageUrl: string | null;
  rawData: Record<string, unknown>;
}

export interface ScraperOptions {
  provider: Provider;
  config: ProviderScraperConfig | null;
  startUrl?: string | null;
  onLog: (level: "DEBUG" | "INFO" | "WARN" | "ERROR", message: string, meta?: Record<string, unknown>) => Promise<void>;
  /** Llamado al terminar cada página con (paginaActual, totalProductosEncontradosHastaAhora) */
  onProgress: (currentPage: number, totalFoundSoFar: number) => Promise<void>;
}

const PRICE_REGEX = /(?:ARS|USD|\$|€)?\s*[\d]{1,3}(?:[.,]\d{3})*(?:[.,]\d{1,2})?/gi;
const SKU_LABELS = /(?:sku|código|codigo|cod\.|artículo|articulo|ref\.|referencia|part\s*n[ou]?\.?)/i;
const STOCK_LABELS = /(?:stock|disponible|sin\s+stock|unidades|cantidad|existencia)/i;

// Tienda Nube (y otros lazy-loaders) usan data:image/gif;base64,... como placeholder en src.
// El valor existe pero no es la URL real, así que hay que descartarlo en cada paso del fallback.
function isValidImageUrl(url: string | undefined): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (trimmed.length === 0) return false;
  if (trimmed.startsWith("data:")) return false;
  return true;
}

// Elige la URL de mayor ancho de un srcset ("url1 240w, url2 1024w" → "url2").
// Si no hay descriptores de ancho, devuelve la última entrada (suele ser la mayor).
// Devuelve undefined si vacío o si todas las candidatas son data URIs.
function bestFromSrcset(srcset: string | undefined): string | undefined {
  if (!srcset) return undefined;
  const candidates = srcset.split(",").map((s) => s.trim()).filter(Boolean);
  let bestUrl = "";
  let bestWidth = 0;
  for (const candidate of candidates) {
    const parts = candidate.split(/\s+/);
    const url = parts[0];
    const widthDescriptor = parts[1] ?? "";
    const width = parseInt(widthDescriptor.replace("w", ""), 10) || 0;
    if (url && !url.startsWith("data:") && width > bestWidth) {
      bestWidth = width;
      bestUrl = url;
    }
  }
  if (!bestUrl && candidates.length > 0) {
    const last = candidates[candidates.length - 1].split(/\s+/)[0] ?? "";
    if (!last.startsWith("data:")) bestUrl = last;
  }
  return isValidImageUrl(bestUrl) ? bestUrl : undefined;
}

export class ScraperService {
  private browser: Browser | null = null;
  private page: Page | null = null;

  async init() {
    this.browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"],
    });
    this.page = await this.browser.newPage();
    await this.page.setExtraHTTPHeaders({
      "Accept-Language": "es-AR,es;q=0.9",
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    });
    this.page.setDefaultTimeout(30000);
    this.page.setDefaultNavigationTimeout(60000);
  }

  async close() {
    if (this.page) await this.page.close().catch(() => {});
    if (this.browser) await this.browser.close().catch(() => {});
  }

  async run(options: ScraperOptions): Promise<ScrapedProduct[]> {
    const { provider, config, startUrl, onLog, onProgress } = options;
    const allProducts: ScrapedProduct[] = [];
    const seenUrls = new Set<string>();
    const seenSkus = new Set<string>();

    await onLog("INFO", `Iniciando extracción para ${provider.name}`);

    await this.init();
    const page = this.page!;

    try {
      const targetUrl = startUrl || provider.baseUrl;
      await onLog("INFO", `Navegando a ${targetUrl}`);
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

      // Login si es requerido
      if (provider.requiresLogin && provider.username && provider.encryptedPassword) {
        await onLog("INFO", "Realizando login...");
        await this.performLogin(page, provider, config, onLog);
      }

      // Esperar selector inicial si está configurado
      if (config?.waitForSelector) {
        try {
          await page.waitForSelector(config.waitForSelector, { timeout: 10000 });
        } catch {
          await onLog("WARN", `waitForSelector "${config.waitForSelector}" no encontrado, continuando...`);
        }
      }

      // Si el sitio usa modo mpage (scroll infinito Tienda Nube), la página inicial
      // también sufre el race entre DOM listo y carga real de cards. Misma espera
      // que aplicamos a cada ?mpage=N en goToNextPage.
      const willUseMpage =
        !!config?.nextPageSelector &&
        this.detectUrlPaginationMode(config.nextPageSelector) === "mpage";
      if (willUseMpage && config?.productCardSelector) {
        try {
          await page.waitForLoadState("networkidle", { timeout: 10000 });
        } catch {
          await onLog("DEBUG", "networkidle inicial no se estabilizó en 10s, continuando");
        }
        const initialCount = await this.waitForProductsToStabilize(page, config.productCardSelector);
        await onLog("DEBUG", `Página inicial: ${initialCount} tarjetas tras estabilizar`);
      }

      const maxPages = config?.maxPages ?? 10;
      let currentPage = 0;
      let arrivedViaUrl = false;
      // En modo mpage de Tienda Nube el DOM acumula las tarjetas de mpages anteriores.
      // Trackeamos cuántas ya procesamos para saltarlas en el próximo extract y no
      // iterar N*pageSize cards cada vez (auto-calibrado al page size real del sitio).
      let inMpageMode = false;
      let cardOffset = 0;
      let stopReason = "loop completado sin break";

      while (currentPage < maxPages) {
        currentPage++;
        await onLog("INFO", `Procesando página ${currentPage}...`);

        const html = await page.content();
        const offsetForExtract = inMpageMode ? cardOffset : 0;
        const prevOffset = cardOffset;
        const { products, totalCards } = await this.extractProductsFromPage(
          html,
          page,
          config,
          provider.baseUrl,
          onLog,
          offsetForExtract
        );

        // Deduplicar
        let added = 0;
        let dupSku = 0;
        let dupUrl = 0;
        let noKey = 0;
        for (const p of products) {
          const key = p.sku || p.productUrl;
          if (!key) { noKey++; continue; }
          if (p.sku && seenSkus.has(p.sku)) { dupSku++; continue; }
          if (p.productUrl && seenUrls.has(p.productUrl)) { dupUrl++; continue; }
          if (p.sku) seenSkus.add(p.sku);
          if (p.productUrl) seenUrls.add(p.productUrl);
          allProducts.push(p);
          added++;
        }

        const domDelta = inMpageMode ? totalCards - prevOffset : totalCards;
        await onLog(
          "INFO",
          `Página ${currentPage}: ${products.length} productos encontrados, ${added} nuevos (DOM: ${totalCards}, delta DOM: +${domDelta})`
        );
        if (products.length > 0 && added === 0) {
          await onLog(
            "DEBUG",
            `Dedup: descartados ${dupSku} por SKU, ${dupUrl} por URL, ${noKey} sin key`
          );
        }
        await onProgress(currentPage, allProducts.length);

        if (inMpageMode) cardOffset = totalCards;

        // En modo URL, una página sin productos nuevos indica fin del catálogo
        if (arrivedViaUrl && added === 0) {
          stopReason = `stop: 0 productos nuevos tras navegación URL (DOM ${totalCards}, offset previo ${prevOffset}, delta ${domDelta}, products ${products.length}, dupSku ${dupSku}, dupUrl ${dupUrl})`;
          await onLog("INFO", "Paginación por URL sin productos nuevos, fin de paginación");
          await onLog("DEBUG", stopReason);
          break;
        }

        // Paginación
        const nextPageSelector = config?.nextPageSelector || "a[rel='next'], .next-page, [aria-label='Siguiente'], .pagination-next";
        const next = await this.goToNextPage(page, nextPageSelector, config?.productCardSelector ?? null, onLog);
        if (!next.ok) {
          stopReason = next.viaUrl
            ? `stop: navegación URL falló (mode=${next.urlMode}) — ver logs previos para status/error`
            : `stop: selector "${nextPageSelector}" no encontrado y sin paginación URL configurada`;
          await onLog("INFO", "No hay más páginas, extracción completada");
          await onLog("DEBUG", stopReason);
          break;
        }
        arrivedViaUrl = next.viaUrl;
        if (next.urlMode === "mpage") {
          inMpageMode = true;
        } else if (next.viaUrl === false) {
          // Selector click rompe la acumulación: reset offset
          inMpageMode = false;
          cardOffset = 0;
        }

        // Pequeña pausa para no sobrecargar el servidor
        await page.waitForTimeout(1500);
      }

      if (currentPage >= maxPages) {
        stopReason = `stop: maxPages=${maxPages} alcanzado`;
        await onLog("WARN", `Se alcanzó el límite de ${maxPages} páginas`);
        await onLog("DEBUG", stopReason);
      }

      await onLog("INFO", `Extracción completada. Total: ${allProducts.length} productos`);
      await onLog("DEBUG", `Motivo final de corte: ${stopReason}`);
      return allProducts;
    } finally {
      await this.close();
    }
  }

  private async performLogin(
    page: Page,
    provider: Provider,
    config: ProviderScraperConfig | null,
    onLog: ScraperOptions["onLog"]
  ) {
    try {
      const password = decrypt(provider.encryptedPassword!);
      const userSelector = config?.loginUsernameSelector || 'input[type="email"], input[name="username"], input[name="email"], #username, #email';
      const passSelector = config?.loginPasswordSelector || 'input[type="password"], #password';
      const submitSelector = config?.loginSubmitSelector || 'button[type="submit"], input[type="submit"], .login-btn';

      await page.fill(userSelector, provider.username!);
      await page.fill(passSelector, password);
      await page.click(submitSelector);
      await page.waitForLoadState("domcontentloaded");
      await onLog("INFO", "Login completado");
    } catch (err) {
      await onLog("ERROR", `Error en login: ${(err as Error).message}`);
      throw err;
    }
  }

  private async extractProductsFromPage(
    html: string,
    page: Page,
    config: ProviderScraperConfig | null,
    baseUrl: string,
    onLog: ScraperOptions["onLog"],
    offset = 0
  ): Promise<{ products: ScrapedProduct[]; totalCards: number }> {
    // Tienda Nube inyecta el <img> con data-srcset vía JS después del render,
    // así que el HTML estático que llega a Cheerio no lo tiene. Capturamos las URLs
    // directamente del DOM con Playwright (que sí ejecutó el JS) y las mapeamos
    // por posición. Si el selector no matchea (otro proveedor), el array queda
    // vacío y se cae a la lógica de atributos existente.
    // Pasamos el código como string literal para que esbuild/tsx no lo transforme
    // (function declarations / nombres de fn inyectan __name() que no existe en el
    // browser context y rompen con ReferenceError). Las barras invertidas de los
    // regex van escapadas porque están dentro de un string.
    const imageUrlsFromDom = (await page.evaluate(`(function() {
  var getBestFromSrcset = function(srcset) {
    if (!srcset) return "";
    var candidates = srcset.split(",").map(function(s) { return s.trim(); }).filter(Boolean);
    var bestUrl = "";
    var bestWidth = 0;
    for (var ci = 0; ci < candidates.length; ci++) {
      var parts = candidates[ci].split(/\\s+/);
      var url = parts[0];
      var widthDescriptor = parts[1] || "";
      var width = parseInt(widthDescriptor.replace("w", ""), 10) || 0;
      if (url && url.indexOf("data:") !== 0 && width > bestWidth) {
        bestWidth = width;
        bestUrl = url;
      }
    }
    if (!bestUrl && candidates.length > 0) {
      bestUrl = (candidates[candidates.length - 1].split(/\\s+/)[0]) || "";
    }
    return (bestUrl.indexOf("data:") === 0) ? "" : bestUrl;
  };

  var upgradeResolution = function(url) {
    return url.replace(/-\\d+-(\\d+)(\\.[a-zA-Z]+)(\\?|$)/, "-1024-$1$2$3");
  };

  var withProtocol = function(url) {
    return url.indexOf("//") === 0 ? "https:" + url : url;
  };

  var imgs = document.querySelectorAll(
    "div.js-item-quickshop-or-colors-container img.js-product-item-image-private:not(.js-product-item-secondary-image-private)"
  );

  return Array.from(imgs).map(function(img) {
    var src = img.getAttribute("src") || "";
    if (src && src.indexOf("data:") !== 0) {
      return withProtocol(upgradeResolution(src));
    }
    var srcset = img.getAttribute("data-srcset") || img.getAttribute("srcset") || "";
    var best = getBestFromSrcset(srcset);
    if (best) return withProtocol(best);
    return "";
  });
})()`)) as string[];

    const $ = cheerio.load(html);
    const products: ScrapedProduct[] = [];

    const cardSelector = config?.productCardSelector || this.detectProductCards($);

    if (!cardSelector) {
      await onLog("WARN", "No se pudo detectar tarjetas de producto automáticamente");
      return { products: [], totalCards: 0 };
    }

    const allCards = $(cardSelector);
    const totalCards = allCards.length;
    const cards = offset > 0 ? allCards.slice(offset) : allCards;
    const imageUrlsSliced = offset > 0 ? imageUrlsFromDom.slice(offset) : imageUrlsFromDom;

    await onLog(
      "DEBUG",
      `Tarjetas con "${cardSelector}": ${totalCards} totales${
        offset > 0 ? `, procesando ${cards.length} desde índice ${offset}` : ""
      }`
    );

    cards.each((index, el) => {
      const card = $(el);
      const playwrightImageUrl = imageUrlsSliced[index] ?? "";
      const product = this.extractFromCard(card, $, config, baseUrl, playwrightImageUrl);
      if (product.name) {
        products.push(product);
      }
    });

    return { products, totalCards };
  }

  private extractFromCard(
    card: cheerio.Cheerio<cheerio.Element>,
    $: cheerio.CheerioAPI,
    config: ProviderScraperConfig | null,
    baseUrl: string,
    playwrightImageUrl = ""
  ): ScrapedProduct {
    const get = (selector: string | null | undefined): string => {
      if (!selector) return "";
      return card.find(selector).first().text().trim();
    };

    const getAttr = (selector: string | null | undefined, attr: string): string => {
      if (!selector) return "";
      return card.find(selector).first().attr(attr) ?? "";
    };

    // Name — limpiar: cuando el selector matchea el contenedor en vez del título exacto,
    // .text() concatena todo el texto interno (precio, descuento, "Comprar", etc.) con \n.
    const rawName =
      get(config?.nameSelector) ||
      card.find("h1, h2, h3, h4, .product-title, .product-name, [class*='title'], [class*='name']").first().text().trim() ||
      "";
    const name = cleanProductName(rawName);

    // SKU
    let sku = get(config?.skuSelector);
    if (!sku) {
      card.find("*").each((_, el) => {
        const text = $(el).text();
        const match = text.match(new RegExp(SKU_LABELS.source + "[:\\s]+([\\w\\-]+)", "i"));
        if (match) { sku = match[1]; return false; }
      });
    }
    // "ART: 1129712" → "1129712", "ART: LS015" → "LS015": tomar el último token tras espacios.
    if (sku) sku = sku.replace(/^.*\s/, "").trim();

    // Price
    let wholesalePrice: number | null = null;
    if (config?.priceSelector) {
      wholesalePrice = parsePrice(get(config.priceSelector));
    } else {
      const priceEl = card.find(".price, [class*='price'], [class*='precio'], ins, .woocommerce-Price-amount").first();
      if (priceEl.length) wholesalePrice = parsePrice(priceEl.text());
    }

    // Old price
    let oldPrice: number | null = null;
    if (config?.oldPriceSelector) {
      oldPrice = parsePrice(get(config.oldPriceSelector));
    } else {
      const oldEl = card.find("del, .old-price, [class*='old'], [class*='anterior'], s").first();
      if (oldEl.length) oldPrice = parsePrice(oldEl.text());
    }

    // Stock
    let stock = get(config?.stockSelector);
    if (!stock) {
      card.find("*").each((_, el) => {
        const text = $(el).text().trim();
        if (STOCK_LABELS.test(text) && text.length < 60) { stock = text; return false; }
      });
    }

    // Category
    const category = get(config?.categorySelector) || card.find(".category, [class*='categ'], breadcrumb").first().text().trim() || "";

    // Description — misma limpieza que name: el contenedor del producto puede traer
    // todo el texto interno mezclado.
    const rawDescription = get(config?.descriptionSelector) || card.find("p, .description, [class*='desc']").first().text().trim() || "";
    const description = cleanProductName(rawDescription);

    // Brand
    const brand = card.find(".brand, [class*='brand'], [class*='marca']").first().text().trim() || "";

    // Image — si Playwright ya resolvió la URL desde el DOM (Tienda Nube), usar eso.
    // Si no, cae a la cadena de atributos: src → data-src → data-lazy → data-original →
    //   data-lazy-src → srcset → data-srcset → background-image inline → bg global.
    let imageUrl = "";
    if (isValidImageUrl(playwrightImageUrl)) {
      imageUrl = playwrightImageUrl;
    } else {
      const imageSelector = config?.imageSelector || "img";
      const imgEl = card.find(imageSelector).first();
      if (imgEl.length) {
        const attrCandidates = [
          imgEl.attr("src"),
          imgEl.attr("data-src"),
          imgEl.attr("data-lazy"),
          imgEl.attr("data-original"),
          imgEl.attr("data-lazy-src"),
        ];
        imageUrl = attrCandidates.find(isValidImageUrl) ?? "";

        if (!imageUrl) {
          const fromSrcset = bestFromSrcset(imgEl.attr("srcset"));
          if (fromSrcset) imageUrl = fromSrcset;
        }
        if (!imageUrl) {
          const fromDataSrcset = bestFromSrcset(imgEl.attr("data-srcset"));
          if (fromDataSrcset) imageUrl = fromDataSrcset;
        }
        if (!imageUrl) {
          const style = imgEl.attr("style") || "";
          const m = style.match(/background-image\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
          if (m && isValidImageUrl(m[1])) imageUrl = m[1];
        }
      }
      // Fallback global: buscar cualquier elemento dentro de la card con background-image inline
      if (!imageUrl) {
        const bg = card.find("[style*='background-image']").first().attr("style") || "";
        const m = bg.match(/background-image\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
        if (m && isValidImageUrl(m[1])) imageUrl = m[1];
      }
    }
    if (imageUrl && !imageUrl.startsWith("http")) {
      try { imageUrl = new URL(imageUrl, baseUrl).href; } catch { imageUrl = ""; }
    }

    // Product URL
    let productUrl = getAttr(config?.productUrlSelector || "a", "href") || card.closest("a").attr("href") || "";
    if (productUrl && !productUrl.startsWith("http")) {
      try { productUrl = new URL(productUrl, baseUrl).href; } catch { productUrl = ""; }
    }

    return {
      sku: sku || null,
      name,
      description: description || null,
      wholesalePrice,
      oldPrice,
      stock: stock || null,
      category: category || null,
      brand: brand || null,
      productUrl: productUrl || null,
      imageUrl: imageUrl || null,
      rawData: { rawText: card.text().slice(0, 500) },
    };
  }

  /** Heurística para detectar el selector de tarjeta de producto más probable */
  private detectProductCards($: cheerio.CheerioAPI): string | null {
    const candidates = [
      ".product",
      ".product-item",
      ".product-card",
      "[class*='product-item']",
      "[class*='product-card']",
      "article.product",
      "li.product",
      ".woocommerce-loop-product__title",
      "[data-product-id]",
      ".item-product",
      ".catalog-item",
    ];

    for (const sel of candidates) {
      const count = $(sel).length;
      if (count >= 2) return sel;
    }

    // Try generic: find repeated li or article with price inside
    const tags = ["li", "article", "div"];
    for (const tag of tags) {
      let bestSel = "";
      let bestCount = 0;
      $(tag).each((_, el) => {
        const cls = ($(el).attr("class") || "").split(" ").find((c) => c.length > 2);
        if (!cls) return;
        const sel = `${tag}.${cls}`;
        const count = $(sel).length;
        if (count > bestCount && count >= 3 && $(el).find("img").length && $(el).text().length > 10) {
          bestCount = count;
          bestSel = sel;
        }
      });
      if (bestSel) return bestSel;
    }

    return null;
  }

  private async goToNextPage(
    page: Page,
    selector: string,
    productCardSelector: string | null,
    onLog: ScraperOptions["onLog"]
  ): Promise<{ ok: boolean; viaUrl: boolean; urlMode: "mpage" | "path" | null }> {
    const urlPaginationMode = this.detectUrlPaginationMode(selector);

    try {
      const nextBtn = page.locator(selector).first();
      const visible = await nextBtn.isVisible({ timeout: 3000 }).catch(() => false);
      if (visible) {
        const href = await nextBtn.getAttribute("href").catch(() => null);
        if (href) {
          await page.goto(href, { waitUntil: "domcontentloaded" });
        } else {
          await nextBtn.click();
          await page.waitForLoadState("domcontentloaded");
        }
        return { ok: true, viaUrl: false, urlMode: null };
      }
    } catch {
      // Cae al modo URL si está activado
    }

    if (urlPaginationMode) {
      const nextUrl = this.buildNextPageUrl(page.url(), urlPaginationMode);
      if (nextUrl) {
        await onLog("INFO", `Selector no encontrado, paginando por URL (${urlPaginationMode}): ${nextUrl}`);
        try {
          const response = await page.goto(nextUrl, { waitUntil: "domcontentloaded" });
          const status = response?.status() ?? 0;
          const actualUrl = page.url();
          await onLog(
            "DEBUG",
            `Navegación URL: solicitada ${nextUrl} → status ${status}, final ${actualUrl}`
          );
          if (response && status >= 400) {
            await onLog("DEBUG", `Página ${nextUrl} devolvió ${status}, fin de paginación`);
            return { ok: false, viaUrl: true, urlMode: urlPaginationMode };
          }
          if (actualUrl !== nextUrl) {
            await onLog(
              "WARN",
              `Redirect: ${nextUrl} → ${actualUrl} (el sitio puede estar redirigiendo mpages fuera de rango)`
            );
          }

          // Modo mpage (scroll infinito): los productos se renderizan tras el load inicial.
          // Esperar a que la red se calme y a que el conteo de tarjetas se estabilice.
          if (urlPaginationMode === "mpage") {
            try {
              await page.waitForLoadState("networkidle", { timeout: 10000 });
            } catch {
              await onLog("DEBUG", "networkidle no se estabilizó en 10s, continuando");
            }
            if (productCardSelector) {
              const finalCount = await this.waitForProductsToStabilize(page, productCardSelector);
              await onLog("DEBUG", `mpage: ${finalCount} tarjetas visibles tras estabilizar`);
            }
          }

          return { ok: true, viaUrl: true, urlMode: urlPaginationMode };
        } catch (err) {
          await onLog("DEBUG", `Error navegando a ${nextUrl}: ${(err as Error).message}`);
          return { ok: false, viaUrl: true, urlMode: urlPaginationMode };
        }
      }
    }

    await onLog("DEBUG", "Botón de siguiente página no encontrado");
    return { ok: false, viaUrl: false, urlMode: null };
  }

  /**
   * Espera a que el conteo de elementos que matchea `selector` se mantenga estable.
   * Polling cada 200ms; retorna apenas el conteo no cambia durante `stableMs`,
   * o tras `maxWaitMs` si nunca se estabiliza.
   */
  private async waitForProductsToStabilize(
    page: Page,
    selector: string,
    maxWaitMs = 5000,
    stableMs = 1000
  ): Promise<number> {
    const start = Date.now();
    let lastCount = await page.locator(selector).count().catch(() => 0);
    let lastChange = Date.now();

    while (Date.now() - start < maxWaitMs) {
      await page.waitForTimeout(200);
      const count = await page.locator(selector).count().catch(() => lastCount);
      if (count !== lastCount) {
        lastCount = count;
        lastChange = Date.now();
      } else if (Date.now() - lastChange >= stableMs) {
        return count;
      }
    }
    return lastCount;
  }

  /**
   * Determina qué estrategia de URL usar según pistas en el selector:
   * - "mpage" o "load-more" → modo mpage (Tienda Nube scroll infinito: ?mpage=N)
   * - "page" → modo path (Tienda Nube paginado clásico: /page/N/)
   * - ninguno → null (sin paginación por URL)
   */
  private detectUrlPaginationMode(selector: string): "mpage" | "path" | null {
    const s = selector.toLowerCase();
    if (s.includes("mpage") || s.includes("load-more")) return "mpage";
    if (s.includes("page")) return "path";
    return null;
  }

  /**
   * Construye la URL de la siguiente página según el modo:
   * - path: /productos/ → /productos/page/2/ → /productos/page/3/...
   * - mpage: /productos → ?mpage=2 → ?mpage=3... (Tienda Nube scroll infinito)
   */
  private buildNextPageUrl(currentUrl: string, mode: "mpage" | "path"): string | null {
    try {
      const url = new URL(currentUrl);

      if (mode === "mpage") {
        const current = url.searchParams.get("mpage");
        const next = current ? parseInt(current, 10) + 1 : 2;
        if (isNaN(next)) return null;
        url.searchParams.set("mpage", String(next));
        return url.toString();
      }

      // mode === "path"
      const match = url.pathname.match(/\/page\/(\d+)\/?$/);
      if (match) {
        const next = parseInt(match[1], 10) + 1;
        url.pathname = url.pathname.replace(/\/page\/\d+\/?$/, `/page/${next}/`);
        return url.toString();
      }
      if (!url.pathname.includes("/page/")) {
        url.pathname = url.pathname.endsWith("/") ? `${url.pathname}page/2/` : `${url.pathname}/page/2/`;
        return url.toString();
      }
      return null;
    } catch {
      return null;
    }
  }
}
