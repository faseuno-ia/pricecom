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

export interface WooStoreApiOptions {
  /** Base del sitio Woo (ej. "https://importadorahaote.com"). */
  baseUrl: string;
  /** Prefijo del SKU comercial (ej. "ELY-"); el sku de la API se ignora. */
  skuPrefix: string;
  /** Fetch inyectado (no se usa `fetch` global directo). */
  fetchFn: FetchFn;
  onProgress?: (currentPage: number, totalFound: number) => void | Promise<void>;
  onLog?: (
    level: "DEBUG" | "INFO" | "WARN" | "ERROR",
    message: string,
    meta?: Record<string, unknown>
  ) => void | Promise<void>;
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

function mapProduct(p: WooApiProduct, skuPrefix: string): ScrapedProduct {
  // Precio CRUDO (sin descuento — el listDiscountPercent lo aplica el pricing-engine).
  // Number(price) / 10^minor_unit: Haote minor=0 → /1; LEDMOMENTS minor=2 → /100.
  const minor = p.prices?.currency_minor_unit ?? 0;
  const rawPrice = p.prices?.price;
  const priceNum = rawPrice != null ? Number(rawPrice) : NaN;
  const wholesalePrice = Number.isFinite(priceNum) ? priceNum / 10 ** minor : null;

  const cats = p.categories ?? [];
  const lastCat = cats.length > 0 ? cats[cats.length - 1] : undefined;

  return {
    sku: `${skuPrefix}${p.id}`, // el sku de la API viene "" → se ignora
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

function collectPage(
  body: unknown,
  out: ScrapedProduct[],
  skuPrefix: string
): void {
  const items = Array.isArray(body) ? (body as WooApiProduct[]) : [];
  for (const item of items) {
    if (shouldExclude(item)) continue;
    out.push(mapProduct(item, skuPrefix));
  }
}

export async function extractWooStoreApi(
  opts: WooStoreApiOptions
): Promise<ScrapedProduct[]> {
  const { baseUrl, skuPrefix, fetchFn, onProgress, onLog } = opts;
  const root = baseUrl.replace(/\/+$/, "");
  const urlFor = (page: number) =>
    `${root}/wp-json/wc/store/v1/products?per_page=${PER_PAGE}&page=${page}`;

  const products: ScrapedProduct[] = [];

  // Página 1: además del cuerpo, leemos X-WP-TotalPages para saber cuántas hay.
  const firstUrl = urlFor(1);
  const first = await fetchFn(firstUrl);
  if (first.status !== 200) {
    const msg = `WooStoreApi: HTTP ${first.status} en página 1 (${firstUrl})`;
    await onLog?.("ERROR", msg, { status: first.status, page: 1 });
    // Fail-loud: NO devolver lista parcial. Una extracción incompleta upserteada
    // marcaría productos faltantes como SUPPLIER_REMOVED erróneamente.
    throw new Error(msg);
  }
  const totalPagesHeader = first.headers.get("X-WP-TotalPages");
  const parsedTotal = parseInt(totalPagesHeader ?? "", 10);
  const totalPages = Number.isFinite(parsedTotal) && parsedTotal >= 1 ? parsedTotal : 1;

  collectPage(await first.json(), products, skuPrefix);
  await onProgress?.(1, products.length);

  for (let page = 2; page <= totalPages; page++) {
    const url = urlFor(page);
    const res = await fetchFn(url);
    if (res.status !== 200) {
      const msg = `WooStoreApi: HTTP ${res.status} en página ${page} (${url})`;
      await onLog?.("ERROR", msg, { status: res.status, page });
      throw new Error(msg);
    }
    collectPage(await res.json(), products, skuPrefix);
    await onProgress?.(page, products.length);
  }

  return products;
}
