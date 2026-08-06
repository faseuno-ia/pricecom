// GATE A2 — walker vivo SKU-first (dos fases) para TiendaNube.
//
// Topología correcta (recuperada de Gate 1C, ver GATE1C-capture-report.md §1/§4):
//   Fase A (discovery): recorrer páginas de LISTADO, extraer URLs de producto,
//     resolver relativas, deduplicar, avanzar SOLO por paginación de listados.
//   Fase B (captura): visitar cada FICHA individual, leer window.LS EN LA FICHA,
//     mapear cada variante a fila reducida; agrupar por sku.trim() al FINAL.
//
// `window.LS.variants` SOLO existe en la ficha individual, no en el listado. Por
// eso el discovery no lee LS y la captura no pagina (`goToNextListing` nunca se
// llama dentro de una ficha).
//
// Toda la I/O (navegación, login, evaluate, logging, cancelación) está inyectada
// vía `WalkerDeps`: el walker es puro y testeable sin red/sitio/Playwright. El
// wiring real (scraper.service) construye las deps a partir de la Page.

import {
  groupSkuFirst,
  mapLsVariantToReducedRow,
  type GroupResult,
  type TnReducedRow,
} from "./tiendanube-sku-first";

/** Payload crudo mínimo (JSON-safe) leído de `window.LS` en una ficha. */
export interface RawLsPagePayload {
  productName: string | null;
  productUrl: string | null;
  domLabels: (string | null)[];
  variants: Record<string, unknown>[];
}

export interface WalkStats {
  listingPagesProcessed: number;
  productsDiscovered: number;
  productsVisited: number;
  productsFailed: number;
  variantsCaptured: number;
}

export interface WalkerDeps {
  // ── Fase A ──────────────────────────────────────────────────────────────
  /**
   * Semilla de discovery sitemap-driven (2G-R3). Cuando está presente y no vacía,
   * la Fase A NO recorre listados: usa estas URLs canónicas (típicamente el
   * `startSnapshot.urls` del sitemap START, la misma autoridad de completitud) como
   * conjunto de discovery. Se re-validan/canonicalizan con `resolveUrl` y se deduplican.
   * Motivo: el listado del storefront demostró ser INCOMPLETO (817<877 en DT), mientras
   * el sitemap ya es la autoridad de completitud. Si está ausente/vacía → Fase A legacy.
   */
  seedProductUrls?: string[];
  /** Extrae los href de producto del listado actual (crudos, sin resolver). */
  extractListingProductUrls: () => Promise<string[]>;
  /** Resuelve/valida un href; devolver null descarta la URL. */
  resolveUrl: (href: string) => string | null;
  /** Avanza al siguiente listado. `true` si avanzó, `false` si no hay más. */
  goToNextListing: () => Promise<boolean>;
  maxListingPages: number;

  // ── Fase B ──────────────────────────────────────────────────────────────
  /** Navega a la ficha; informa si el sitio redirigió a login. */
  navigateToProduct: (url: string) => Promise<{ redirectedToLogin: boolean }>;
  /** Re-autentica reutilizando el login existente. */
  reLogin: () => Promise<void>;
  /** Lee window.LS de la ficha actual. Lanza ante fallo transitorio. */
  captureLsPayload: () => Promise<RawLsPagePayload>;
  maxProductRetries: number;

  // ── Transversal ─────────────────────────────────────────────────────────
  now: () => string;
  isCancelled: () => boolean;
  onLog: (level: "DEBUG" | "INFO" | "WARN" | "ERROR", msg: string) => Promise<void>;
  onProgress: (stats: WalkStats) => Promise<void>;
}

/** Fase A: recolecta URLs de producto de los listados, deduplicadas y ordenadas. */
export async function collectProductUrlsFromListings(
  deps: WalkerDeps,
): Promise<{ urls: string[]; listingPages: number }> {
  const seen = new Set<string>();
  const urls: string[] = [];
  let listingPages = 0;

  while (listingPages < deps.maxListingPages) {
    if (deps.isCancelled()) break;
    listingPages++;
    const rawHrefs = await deps.extractListingProductUrls();
    for (const href of rawHrefs) {
      const resolved = deps.resolveUrl(href);
      if (!resolved) continue;
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      urls.push(resolved);
    }
    if (deps.isCancelled()) break;
    const advanced = await deps.goToNextListing();
    if (!advanced) break;
  }
  return { urls, listingPages };
}

/**
 * Fase A sitemap-driven (2G-R3): canonicaliza/valida/deduplica el seed sin recorrer
 * listados. Reusa `resolveUrl` (mismo predicado de producto + canonicalización que la
 * Fase A de listados) para que una URL basura del sitemap no entre al discovery. NO
 * garantiza captura: cada URL entra recién al ACCEPTED_WALK_SET si la Fase B la acepta.
 */
export function collectProductUrlsFromSeed(
  seed: string[],
  deps: WalkerDeps,
): { urls: string[]; rejected: number; duplicates: number } {
  const seen = new Set<string>();
  const urls: string[] = [];
  let rejected = 0;
  let duplicates = 0;
  for (const href of seed) {
    const resolved = deps.resolveUrl(href);
    if (!resolved) { rejected++; continue; }
    if (seen.has(resolved)) { duplicates++; continue; }
    seen.add(resolved);
    urls.push(resolved);
  }
  return { urls, rejected, duplicates };
}

/** Mapea el payload de una ficha a filas reducidas (una por variante). */
export function mapProductPagePayloadToReducedRows(
  payload: RawLsPagePayload | null,
  sourcePageIndex: number,
  capturedAt: string,
): TnReducedRow[] {
  if (!payload || !Array.isArray(payload.variants) || payload.variants.length === 0) return [];
  const fallbackProductId = (payload.variants[0]?.product_id as unknown) ?? null;
  return payload.variants.map(
    (rawVariant, sourceVariantIndex) =>
      mapLsVariantToReducedRow(rawVariant, {
        sourcePageIndex,
        sourceVariantIndex,
        productId: (rawVariant.product_id as unknown) ?? fallbackProductId,
        productName: payload.productName,
        productUrl: payload.productUrl,
        domLabels: payload.domLabels ?? [],
        capturedAt,
      }) as unknown as TnReducedRow,
  );
}

/**
 * Fase B (una ficha): navega, maneja redirección a login + re-login, captura
 * window.LS con retry acotado y mapea. Devuelve las filas, o `null` si la ficha
 * falló definitivamente (el caller reporta y continúa). NUNCA pagina.
 */
export async function captureProductRows(
  url: string,
  sourcePageIndex: number,
  deps: WalkerDeps,
): Promise<TnReducedRow[] | null> {
  for (let attempt = 0; attempt <= deps.maxProductRetries; attempt++) {
    try {
      let nav = await deps.navigateToProduct(url);
      if (nav.redirectedToLogin) {
        await deps.reLogin();
        nav = await deps.navigateToProduct(url);
      }
      const payload = await deps.captureLsPayload();
      const rows = mapProductPagePayloadToReducedRows(payload, sourcePageIndex, deps.now());
      if (rows.length === 0) {
        await deps.onLog("WARN", `Ficha sin variantes (window.LS vacío o ausente), se omite`);
      }
      return rows;
    } catch {
      if (attempt === deps.maxProductRetries) {
        await deps.onLog("WARN", `Ficha falló definitivamente tras ${attempt + 1} intento(s), se omite y continúa`);
        return null;
      }
      await deps.onLog("DEBUG", `Reintentando ficha (intento ${attempt + 2})`);
    }
  }
  return null;
}

/** Orquesta las dos fases y agrupa por SKU al final. */
export async function runSkuFirstWalk(
  deps: WalkerDeps,
): Promise<GroupResult & { stats: WalkStats }> {
  // Fase A. Sitemap-driven (2G-R3) cuando hay seed: NO recorre listados (el listado del
  // storefront es incompleto); usa el START_SET como conjunto de discovery. Sin seed →
  // discovery legacy por listados. En AMBOS casos el ACCEPTED_WALK_SET (autoridad de
  // completitud) se llena SOLO con capturas aceptadas en Fase B, nunca con el seed.
  let urls: string[];
  let listingPages: number;
  if (deps.seedProductUrls && deps.seedProductUrls.length > 0) {
    await deps.onLog("INFO", "[SKU-first] Fase A: discovery desde sitemap START_SET");
    const seeded = collectProductUrlsFromSeed(deps.seedProductUrls, deps);
    urls = seeded.urls;
    listingPages = 0;
    await deps.onLog(
      "INFO",
      `[SKU-first] Fase A: ${urls.length} URLs canónicas sembradas desde sitemap ` +
        `(raw=${deps.seedProductUrls.length}, rechazadas=${seeded.rejected}, duplicadas=${seeded.duplicates})`,
    );
  } else {
    await deps.onLog("INFO", "[SKU-first] Fase A: discovery de URLs de producto en listados");
    const collected = await collectProductUrlsFromListings(deps);
    urls = collected.urls;
    listingPages = collected.listingPages;
    await deps.onLog("INFO", `[SKU-first] Fase A: ${urls.length} URLs únicas en ${listingPages} listados`);
  }

  const stats: WalkStats = {
    listingPagesProcessed: listingPages,
    productsDiscovered: urls.length,
    productsVisited: 0,
    productsFailed: 0,
    variantsCaptured: 0,
  };

  const allRows: TnReducedRow[] = [];
  await deps.onLog("INFO", "[SKU-first] Fase B: captura de fichas individuales");
  for (let i = 0; i < urls.length; i++) {
    if (deps.isCancelled()) {
      await deps.onLog("INFO", "[SKU-first] Cancelado durante captura de fichas");
      break;
    }
    const rows = await captureProductRows(urls[i], i, deps);
    stats.productsVisited++;
    if (rows === null) {
      stats.productsFailed++;
    } else {
      allRows.push(...rows);
      stats.variantsCaptured += rows.length;
    }
    await deps.onProgress({ ...stats });
  }

  const grouped = groupSkuFirst(allRows);
  await deps.onLog(
    "INFO",
    `[SKU-first] Agrupación final: ${grouped.products.length} productos, ` +
      `${grouped.quarantine.length} en cuarentena, ${grouped.diagnostics.variantsPreserved} variantes preservadas`,
  );
  return { ...grouped, stats };
}
