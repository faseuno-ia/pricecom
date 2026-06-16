// Extractor "WooCommerce Store API" — módulo PURO (no toca DB ni red global):
// pagina la Store API (wp-json/wc/store/v1/products) y devuelve ScrapedProduct[],
// el MISMO contrato que ScraperService.run(), para entrar al pipeline existente
// (createMany + upsertCatalogProducts) vía el branch de dispatch (etapa 3).
//
// Las dependencias (fetch) se INYECTAN → testeable con fixtures, sin red.

import type { ScrapedProduct } from "@/lib/scraper/scraper.service";

/** Respuesta mínima tipo `Response` que el extractor necesita. `fetch` global la cumple. */
export interface FetchLikeResponse {
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}

/** Fetch inyectado: en prod = `fetch` real; en tests = fake que sirve fixtures. */
export type FetchFn = (url: string) => Promise<FetchLikeResponse>;

/** Espera inyectable: en prod = setTimeout; en tests = fake que registra delays. */
export type SleepFn = (ms: number) => Promise<void>;

export interface WooStoreApiOptions {
  /** Base del sitio Woo (ej. "https://importadorahaote.com"). */
  baseUrl: string;
  /**
   * Prefijo del SKU COMERCIAL del proveedor (ej. "ELY-"). NO se usa para el
   * sku del proveedor (ScrapedProduct.sku = id pelado): el prefijo se aplica
   * recién al publicar, donde el SKU comercial = provider.skuPrefix + cp.sku.
   * Se mantiene en la firma por compatibilidad con el call site del worker.
   */
  skuPrefix: string;
  /** Fetch inyectado (no se usa `fetch` global directo). */
  fetchFn: FetchFn;
  onProgress?: (
    currentPage: number,
    totalPages: number,
    totalFound: number
  ) => void | Promise<void>;
  onLog?: (
    level: "DEBUG" | "INFO" | "WARN" | "ERROR",
    message: string,
    meta?: Record<string, unknown>
  ) => void | Promise<void>;
  /**
   * Espera entre reintentos. Opcional: default = setTimeout real. En tests se
   * inyecta un fake que registra los delays sin esperar.
   */
  sleep?: SleepFn;
}

// ── Shape (parcial, defensivo) del producto de la Store API ────────────────────
interface WooApiPrices {
  price?: string | null;
  /** null para simples; objeto {min_amount,max_amount} para variables con rango. */
  price_range?: unknown;
  currency_minor_unit?: number;
}
interface WooApiImage {
  src?: string | null;
}
interface WooApiCategory {
  name?: string | null;
}
interface WooApiProduct {
  id: number;
  name?: string;
  sku?: string;
  description?: string | null;
  permalink?: string | null;
  type?: string;
  is_purchasable?: boolean;
  prices?: WooApiPrices;
  images?: WooApiImage[];
  categories?: WooApiCategory[];
}

const PER_PAGE = 100;

// Status transitorios reintentables (cache-warming del proveedor). Todo otro
// status ≠ 200 es TERMINAL → fail-loud inmediato (incl. 500, a propósito).
const RETRYABLE_STATUSES = new Set([202, 429, 503]);
// Backoff fijo y determinístico (sin jitter). El presupuesto de reintentos por
// página = RETRY_DELAYS_MS.length (no hay número mágico aparte): subirlo = editar
// este array.
const RETRY_DELAYS_MS = [500, 1500, 3000];

// ── Filtros de exclusión (DEFAULT para proveedores Woo) ────────────────────────
// Son criterios de exclusión del extractor. Si un proveedor futuro difiere (ej.
// vende bundles reales que sí quiere publicar), se ajustan acá — no en el pipeline.
const isNotPurchasable = (p: WooApiProduct) => p.is_purchasable === false; // alquiler / no comprables
const isBundle = (p: WooApiProduct) => p.type === "woosb"; // bundles/combos (plugin WooSB)
const isVariableWithRange = (p: WooApiProduct) =>
  p.type === "variable" && p.prices?.price_range != null; // variable con rango de precio

function shouldExclude(p: WooApiProduct): boolean {
  return isNotPurchasable(p) || isBundle(p) || isVariableWithRange(p);
}

function mapProduct(p: WooApiProduct): ScrapedProduct {
  // Precio CRUDO (sin descuento — el listDiscountPercent lo aplica el pricing-engine).
  // Number(price) / 10^minor_unit: Haote minor=0 → /1; LEDMOMENTS minor=2 → /100.
  const minor = p.prices?.currency_minor_unit ?? 0;
  const rawPrice = p.prices?.price;
  const priceNum = rawPrice != null ? Number(rawPrice) : NaN;
  const wholesalePrice = Number.isFinite(priceNum) ? priceNum / 10 ** minor : null;

  const cats = p.categories ?? [];
  const lastCat = cats.length > 0 ? cats[cats.length - 1] : undefined;

  return {
    sku: String(p.id), // id pelado; el prefijo se aplica al publicar (SKU comercial), NO acá
    name: p.name ?? "",
    description: p.description ? p.description : null, // "" → null
    wholesalePrice,
    oldPrice: null,
    stock: null, // ignoramos is_in_stock: presencia en la API = disponible
    category: lastCat?.name ?? null, // ÚLTIMA del array = más específica
    brand: null,
    productUrl: p.permalink ?? null,
    imageUrl: p.images?.[0]?.src ?? null, // solo la principal en esta etapa
    rawData: p as unknown as Record<string, unknown>, // crudo, trazabilidad
  };
}

function collectPage(body: unknown, out: ScrapedProduct[]): void {
  const items = Array.isArray(body) ? (body as WooApiProduct[]) : [];
  for (const item of items) {
    if (shouldExclude(item)) continue;
    out.push(mapProduct(item));
  }
}

// Fetchea `url` y devuelve la response 200 CRUDA (el caller hace headers.get /
// json()). Ante un status transitorio (202/429/503) reintenta con backoff fijo,
// hasta agotar RETRY_DELAYS_MS. Cualquier otro status ≠ 200 → throw inmediato
// (terminal). Reintentables agotados → throw. Nunca colecta de una response
// no-200 (solo retorna la 200). Presupuesto POR LLAMADA (cada página la suya).
async function fetchOkWithRetry(
  url: string,
  page: number,
  fetchFn: FetchFn,
  sleep: SleepFn,
  onLog?: WooStoreApiOptions["onLog"]
): Promise<FetchLikeResponse> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetchFn(url);
    if (res.status === 200) return res;

    const msg = `WooStoreApi: HTTP ${res.status} en página ${page} (${url})`;
    // Terminal: 4xx salvo 429, 5xx salvo 503, etc. Fail-loud inmediato.
    if (!RETRYABLE_STATUSES.has(res.status)) {
      await onLog?.("ERROR", msg, { status: res.status, page });
      throw new Error(msg);
    }
    // Reintentable pero sin presupuesto restante → fail-loud.
    if (attempt >= RETRY_DELAYS_MS.length) {
      await onLog?.("ERROR", `${msg} — reintentos agotados`, {
        status: res.status,
        page,
        attempts: attempt,
      });
      throw new Error(msg);
    }
    // Reintentable con presupuesto: log + backoff y reintenta la MISMA url.
    const delay = RETRY_DELAYS_MS[attempt];
    await onLog?.("WARN", `${msg} — reintentando en ${delay}ms`, {
      status: res.status,
      page,
      attempt,
      delay,
    });
    await sleep(delay);
  }
}

export async function extractWooStoreApi(
  opts: WooStoreApiOptions
): Promise<ScrapedProduct[]> {
  // skuPrefix existe en opts pero NO se usa acá (ver comentario en la interfaz):
  // el sku del proveedor es el id pelado; el prefijo se aplica al publicar.
  const { baseUrl, fetchFn, onProgress, onLog } = opts;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const root = baseUrl.replace(/\/+$/, "");
  const urlFor = (page: number) =>
    `${root}/wp-json/wc/store/v1/products?per_page=${PER_PAGE}&page=${page}`;

  const products: ScrapedProduct[] = [];

  // Página 1: además del cuerpo, leemos X-WP-TotalPages para saber cuántas hay.
  // fetchOkWithRetry garantiza 200 o throw (fail-loud): NO devolver lista parcial.
  // Una extracción incompleta upserteada marcaría faltantes como SUPPLIER_REMOVED.
  const firstUrl = urlFor(1);
  const first = await fetchOkWithRetry(firstUrl, 1, fetchFn, sleep, onLog);
  const totalPagesHeader = first.headers.get("X-WP-TotalPages");
  const parsedTotal = parseInt(totalPagesHeader ?? "", 10);
  const totalPages = Number.isFinite(parsedTotal) && parsedTotal >= 1 ? parsedTotal : 1;

  collectPage(await first.json(), products);
  await onProgress?.(1, totalPages, products.length);

  for (let page = 2; page <= totalPages; page++) {
    const url = urlFor(page);
    const res = await fetchOkWithRetry(url, page, fetchFn, sleep, onLog);
    collectPage(await res.json(), products);
    await onProgress?.(page, totalPages, products.length);
  }

  return products;
}
