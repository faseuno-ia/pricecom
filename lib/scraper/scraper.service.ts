import { chromium, Browser, Page } from "playwright";
import * as cheerio from "cheerio";
import { ProviderScraperConfig, Provider } from "@prisma/client";
import { parsePrice } from "../utils/index";
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

      const maxPages = config?.maxPages ?? 10;
      let currentPage = 0;
      let arrivedViaUrl = false;

      while (currentPage < maxPages) {
        currentPage++;
        await onLog("INFO", `Procesando página ${currentPage}...`);

        const html = await page.content();
        const products = await this.extractProductsFromPage(html, page, config, provider.baseUrl, onLog);

        // Deduplicar
        let added = 0;
        for (const p of products) {
          const key = p.sku || p.productUrl;
          if (!key) continue;
          if (p.sku && seenSkus.has(p.sku)) continue;
          if (p.productUrl && seenUrls.has(p.productUrl)) continue;
          if (p.sku) seenSkus.add(p.sku);
          if (p.productUrl) seenUrls.add(p.productUrl);
          allProducts.push(p);
          added++;
        }

        await onLog("INFO", `Página ${currentPage}: ${products.length} productos encontrados, ${added} nuevos`);
        await onProgress(currentPage, allProducts.length);

        // En modo URL, una página sin productos nuevos indica fin del catálogo
        if (arrivedViaUrl && added === 0) {
          await onLog("INFO", "Paginación por URL sin productos nuevos, fin de paginación");
          break;
        }

        // Paginación
        const nextPageSelector = config?.nextPageSelector || "a[rel='next'], .next-page, [aria-label='Siguiente'], .pagination-next";
        const next = await this.goToNextPage(page, nextPageSelector, onLog);
        if (!next.ok) {
          await onLog("INFO", "No hay más páginas, extracción completada");
          break;
        }
        arrivedViaUrl = next.viaUrl;

        // Pequeña pausa para no sobrecargar el servidor
        await page.waitForTimeout(1500);
      }

      if (currentPage >= maxPages) {
        await onLog("WARN", `Se alcanzó el límite de ${maxPages} páginas`);
      }

      await onLog("INFO", `Extracción completada. Total: ${allProducts.length} productos`);
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
    onLog: ScraperOptions["onLog"]
  ): Promise<ScrapedProduct[]> {
    const $ = cheerio.load(html);
    const products: ScrapedProduct[] = [];

    const cardSelector = config?.productCardSelector || this.detectProductCards($);

    if (!cardSelector) {
      await onLog("WARN", "No se pudo detectar tarjetas de producto automáticamente");
      return [];
    }

    const cards = $(cardSelector);
    await onLog("DEBUG", `Encontradas ${cards.length} tarjetas con selector "${cardSelector}"`);

    cards.each((_, el) => {
      const card = $(el);
      const product = this.extractFromCard(card, $, config, baseUrl);
      if (product.name) {
        products.push(product);
      }
    });

    return products;
  }

  private extractFromCard(
    card: cheerio.Cheerio<cheerio.Element>,
    $: cheerio.CheerioAPI,
    config: ProviderScraperConfig | null,
    baseUrl: string
  ): ScrapedProduct {
    const get = (selector: string | null | undefined): string => {
      if (!selector) return "";
      return card.find(selector).first().text().trim();
    };

    const getAttr = (selector: string | null | undefined, attr: string): string => {
      if (!selector) return "";
      return card.find(selector).first().attr(attr) ?? "";
    };

    // Name
    const name =
      get(config?.nameSelector) ||
      card.find("h1, h2, h3, h4, .product-title, .product-name, [class*='title'], [class*='name']").first().text().trim() ||
      "";

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

    // Description
    const description = get(config?.descriptionSelector) || card.find("p, .description, [class*='desc']").first().text().trim() || "";

    // Brand
    const brand = card.find(".brand, [class*='brand'], [class*='marca']").first().text().trim() || "";

    // Image — orden de fallback: src → data-src → data-original → data-lazy-src → srcset → background-image (CSS).
    // Algunos sitios (Toys Palace) no usan <img> sino un <div style="background-image:url(...)">.
    // Tienda Nube (Bazar 380) usa src=data:image/gif;base64... y la URL real está en srcset.
    const imageSelector = config?.imageSelector || "img";
    const imgEl = card.find(imageSelector).first();
    let imageUrl = "";
    if (imgEl.length) {
      const candidates = [
        imgEl.attr("src"),
        imgEl.attr("data-src"),
        imgEl.attr("data-original"),
        imgEl.attr("data-lazy-src"),
      ];
      imageUrl = candidates.find((v) => v && !v.startsWith("data:")) ?? "";
      if (!imageUrl) {
        const srcset = imgEl.attr("srcset") || imgEl.attr("data-srcset") || "";
        if (srcset) {
          // srcset: "url1 240w, url2 320w, ..." — tomar la primera URL (menor tamaño)
          const first = srcset.split(",")[0]?.trim().split(/\s+/)[0];
          if (first && !first.startsWith("data:")) imageUrl = first;
        }
      }
      if (!imageUrl) {
        const style = imgEl.attr("style") || "";
        const m = style.match(/background-image\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
        if (m) imageUrl = m[1];
      }
    }
    // Fallback global: buscar cualquier elemento dentro de la card con background-image inline
    if (!imageUrl) {
      const bg = card.find("[style*='background-image']").first().attr("style") || "";
      const m = bg.match(/background-image\s*:\s*url\(\s*['"]?([^'")]+)['"]?\s*\)/i);
      if (m) imageUrl = m[1];
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
    onLog: ScraperOptions["onLog"]
  ): Promise<{ ok: boolean; viaUrl: boolean }> {
    const urlPaginationMode = selector.toLowerCase().includes("page");

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
        return { ok: true, viaUrl: false };
      }
    } catch {
      // Cae al modo URL si está activado
    }

    if (urlPaginationMode) {
      const nextUrl = this.buildNextPageUrl(page.url());
      if (nextUrl) {
        await onLog("INFO", `Selector no encontrado, paginando por URL: ${nextUrl}`);
        try {
          const response = await page.goto(nextUrl, { waitUntil: "domcontentloaded" });
          if (response && response.status() >= 400) {
            await onLog("DEBUG", `Página ${nextUrl} devolvió ${response.status()}, fin de paginación`);
            return { ok: false, viaUrl: true };
          }
          return { ok: true, viaUrl: true };
        } catch (err) {
          await onLog("DEBUG", `Error navegando a ${nextUrl}: ${(err as Error).message}`);
          return { ok: false, viaUrl: true };
        }
      }
    }

    await onLog("DEBUG", "Botón de siguiente página no encontrado");
    return { ok: false, viaUrl: false };
  }

  // Patrón Tienda Nube: /productos/ → /productos/page/2/ → /productos/page/3/...
  private buildNextPageUrl(currentUrl: string): string | null {
    try {
      const url = new URL(currentUrl);
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
