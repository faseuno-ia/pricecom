// 2G-R7.2 / R7.2-R1 — Autoridad de escritura del catálogo, config-driven y GENÉRICA.
// Resolver fail-loud (patrón resolveExtractionMode) + PREVALIDACIÓN de dos fases para PRICE_ONLY.
// Pure: sin red/DB/IO. NO sustituye ni modifica D (pre-write-price-guard); sólo asegura que los
// errores DETERMINÍSTICOS de input (SKU inválido/nuevo, precio inválido) fallen ANTES del primer write.

export type CatalogWriteMode = "FULL" | "PRICE_ONLY";

/** Fail-loud error ante un catalogWriteMode inválido no vacío. Incluye field + rawValue, sin secretos. */
export class CatalogWriteModeError extends Error {
  readonly field = "catalogWriteMode";
  readonly rawValue: string;
  constructor(rawValue: string) {
    super(`Invalid catalogWriteMode: field=catalogWriteMode rawValue=${JSON.stringify(rawValue)} (valid: FULL, PRICE_ONLY)`);
    this.name = "CatalogWriteModeError";
    this.rawValue = rawValue;
  }
}

/**
 * Resuelve el modo. Semántica EXACTA:
 *   null | undefined | "" | whitespace-only → "FULL"
 *   "FULL" → "FULL"   ·   "PRICE_ONLY" → "PRICE_ONLY"
 *   otro string no vacío, o no-string no null/undefined → throw CatalogWriteModeError (nunca cae a FULL en silencio).
 * (trim sólo para detectar blank; comparación exact-case sobre el trimmed.)
 */
export function resolveCatalogWriteMode(raw: unknown): CatalogWriteMode {
  if (raw === null || raw === undefined) return "FULL";
  if (typeof raw !== "string") throw new CatalogWriteModeError(String(raw));
  const trimmed = raw.trim();
  if (trimmed === "") return "FULL";
  if (trimmed === "FULL") return "FULL";
  if (trimmed === "PRICE_ONLY") return "PRICE_ONLY";
  throw new CatalogWriteModeError(trimmed);
}

/** VALID_PRICE (policy autosuficiente): número finito > 0. Misma semántica que la selección productiva. */
export function isValidWholesalePrice(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

// ── Errores tipados PRICE_ONLY (distintos: identidad inválida ≠ entidad ausente ≠ precio inválido) ──
export class PriceOnlyInvalidSkuError extends Error {
  readonly reasonCode = "PRICE_ONLY_INVALID_SKU";
  constructor(sku: string | null) { super(`PRICE_ONLY_INVALID_SKU sku=${JSON.stringify(sku)}`); this.name = "PriceOnlyInvalidSkuError"; }
}
export class PriceOnlyNewSkuError extends Error {
  readonly reasonCode = "PRICE_ONLY_NEW_SKU_NOT_ALLOWED";
  constructor(sku: string | null) { super(`PRICE_ONLY_NEW_SKU_NOT_ALLOWED sku=${JSON.stringify(sku)}`); this.name = "PriceOnlyNewSkuError"; }
}
export class PriceOnlyInvalidPriceError extends Error {
  readonly reasonCode = "PRICE_ONLY_INVALID_PRICE";
  constructor(sku: string) { super(`PRICE_ONLY_INVALID_PRICE sku=${JSON.stringify(sku)}`); this.name = "PriceOnlyInvalidPriceError"; }
}

export interface PriceOnlyIncoming { sku: string | null; wholesalePrice: number | null; extractedProductId: string; }
export interface PriceOnlyResolvedUpdate { catalogProductId: string; wholesalePrice: number; latestExtractedProductId: string; }

/**
 * PHASE 1 (pura) — VALIDA TODO el incoming y resuelve los updates en memoria, SIN escribir.
 * Lanza ANTES de devolver nada ante el PRIMER error determinístico (independiente de la POSICIÓN):
 *   - SKU null/blank → PriceOnlyInvalidSkuError;
 *   - wholesalePrice inválido (no número finito > 0) → PriceOnlyInvalidPriceError (autosuficiente, sin D);
 *   - SKU no presente en `existingBySku` → PriceOnlyNewSkuError.
 * El caller sólo entra a PHASE 2 (writes) si esto retorna sin lanzar ⇒ CERO writes ante cualquier
 * error determinístico de input. NO garantiza atomicidad de PHASE 2 (un fallo de DB mid-loop puede
 * dejar writes 1..N-1 persistidos; la mitigación es PRE_CANARY_SNAPSHOT + POST_CANARY_DIFF).
 */
export function resolvePriceOnlyBatch(
  incoming: PriceOnlyIncoming[],
  existingBySku: Map<string, { id: string }>,
): PriceOnlyResolvedUpdate[] {
  const out: PriceOnlyResolvedUpdate[] = [];
  for (const inc of incoming) {
    const sku = typeof inc.sku === "string" ? inc.sku.trim() : "";
    if (!sku) throw new PriceOnlyInvalidSkuError(inc.sku);
    if (!isValidWholesalePrice(inc.wholesalePrice)) throw new PriceOnlyInvalidPriceError(sku);
    const existing = existingBySku.get(sku);
    if (!existing) throw new PriceOnlyNewSkuError(sku);
    out.push({ catalogProductId: existing.id, wholesalePrice: inc.wholesalePrice, latestExtractedProductId: inc.extractedProductId });
  }
  return out;
}
