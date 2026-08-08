// 2G-R8-Q2 · §9 — Mapeo FICHA ↔ SKU (módulo PURO, sin IO/DB/red).
//
// Deja disponibles los DOS insumos que Q2.1 necesitará para reconciliar SKUs sin
// rehacer captura:
//   FICHA_TO_SKUS_MAP        — desde capturas VERIFIED_OK (qué SKUs tiene una ficha).
//   CATALOG_SKU_TO_FICHA_MAP — desde el catálogo histórico (a qué ficha pertenece un SKU).
//
// La identidad de ficha es CANÓNICA (§9) y se usa EXCLUSIVAMENTE para identidad/
// reconciliación, NUNCA para navegar/reintentar (§10). Reglas de canonicalización
// (heredadas de normalizeCatalogUrl): origin normalizado (https asumido, host en
// minúsculas), pathname sin trailing slash, query y fragment DESCARTADOS, scheme
// no forma parte de la identidad (se devuelve host+path).
//
// Un SKU que no mapea inequívocamente a UNA ficha (sin ficha resoluble, o que mapea a
// >1 ficha) queda marcado UNMAPPABLE/COLLISION → en Q2.1 será SKU_UNVERIFIED y la
// inferencia de ausencia para él queda DESHABILITADA (ABSENCE_INFERENCE_FOR_
// AMBIGUOUS_MAPPING = DISABLED).

import { normalizeCatalogUrl } from "./url-normalization";

/** Identidad canónica de ficha (§9). null si la URL es vacía/ inválida. */
export function fichaIdentity(url: string | null): string | null {
  if (url == null) return null;
  return normalizeCatalogUrl(url);
}

// ── FICHA_TO_SKUS_MAP (desde captura) ─────────────────────────────────────────
export interface CapturedFichaForMapping {
  /** productUrl de la ficha capturada (preferido para identidad). */
  fichaUrl: string | null;
  /** URL exacta que navegó el walker (fallback de identidad si fichaUrl es null). */
  navigationUrl: string;
  /** SKUs (trim) observados en la ficha. */
  skus: string[];
}

/**
 * Construye FICHA_TO_SKUS_MAP: identidad canónica de ficha → SKUs ordenados y únicos.
 * Identidad = canónica(fichaUrl) o, si falta, canónica(navigationUrl). Descarta SKUs vacíos.
 * Fichas cuya identidad no resuelve se agrupan bajo la navigationUrl cruda (no se pierden).
 */
export function buildFichaToSkusMap(fichas: CapturedFichaForMapping[]): Record<string, string[]> {
  const map = new Map<string, Set<string>>();
  for (const f of fichas) {
    const key = fichaIdentity(f.fichaUrl) ?? fichaIdentity(f.navigationUrl) ?? f.navigationUrl;
    if (!map.has(key)) map.set(key, new Set());
    const set = map.get(key)!;
    for (const raw of f.skus) {
      const sku = (raw ?? "").trim();
      if (sku !== "") set.add(sku);
    }
  }
  const out: Record<string, string[]> = {};
  for (const [k, v] of map) out[k] = [...v].sort();
  return out;
}

// ── CATALOG_SKU_TO_FICHA_MAP (desde catálogo histórico) ───────────────────────
export interface CatalogRowForMapping {
  sku: string | null;
  productUrl: string | null;
}

export interface CatalogSkuToFichaMap {
  /** sku → ficha canónica, SÓLO para SKUs no ambiguos (mapeados a exactamente una ficha). */
  skuToFicha: Record<string, string>;
  distinctFichas: number;
  distinctSkus: number;
  /** filas sin SKU no-vacío (no clasificables por SKU). */
  rowsWithoutSku: number;
  /** SKU no-vacío sin ficha resoluble (productUrl null/inválido). */
  unmappableSkus: string[];
  unmappableCount: number;
  /** SKU que mapea a >1 ficha canónica distinta (ambiguo). */
  collisionSkus: string[];
  collisionCount: number;
  /** true si no hay unmappable ni colisiones → mapping totalmente resoluble. */
  resolvable: boolean;
}

/**
 * Construye CATALOG_SKU_TO_FICHA_MAP y su auditoría (§9). NO lanza. Determinístico:
 * salidas ordenadas. Un SKU con colisión NO entra a `skuToFicha` (queda ambiguo).
 */
export function buildCatalogSkuToFichaMap(rows: CatalogRowForMapping[]): CatalogSkuToFichaMap {
  const skuToFichas = new Map<string, Set<string>>();
  const unmappable = new Set<string>();
  let rowsWithoutSku = 0;
  const distinctFichas = new Set<string>();

  for (const r of rows) {
    const sku = (r.sku ?? "").trim();
    if (sku === "") { rowsWithoutSku++; continue; }
    const ficha = fichaIdentity(r.productUrl);
    if (!ficha) { unmappable.add(sku); continue; }
    distinctFichas.add(ficha);
    if (!skuToFichas.has(sku)) skuToFichas.set(sku, new Set());
    skuToFichas.get(sku)!.add(ficha);
  }

  const collisions: string[] = [];
  const skuToFicha: Record<string, string> = {};
  for (const [sku, fichas] of skuToFichas) {
    if (fichas.size > 1) collisions.push(sku);
    else skuToFicha[sku] = [...fichas][0];
  }
  const unmappableSkus = [...unmappable].sort();
  const collisionSkus = collisions.sort();
  return {
    skuToFicha,
    distinctFichas: distinctFichas.size,
    distinctSkus: skuToFichas.size,
    rowsWithoutSku,
    unmappableSkus,
    unmappableCount: unmappableSkus.length,
    collisionSkus,
    collisionCount: collisionSkus.length,
    resolvable: unmappableSkus.length === 0 && collisionSkus.length === 0,
  };
}
