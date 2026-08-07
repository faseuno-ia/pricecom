// ─────────────────────────────────────────────────────────────────────────────
// Modo de escritura del catálogo (fail-loud, sin IO). Sigue el patrón de
// resolveExtractionMode en lib/scraper/tiendanube-sku-first.ts:
//   - null/undefined/""/blank → default silencioso (FULL).
//   - valor no reconocido → throw fail-loud (nunca cae en silencio al default).
//   - trim() SOLO detecta blank; la comparación es exact-case sobre el valor recortado.
// ─────────────────────────────────────────────────────────────────────────────

export type CatalogWriteMode = "FULL" | "PRICE_ONLY";

/** Fail-loud error for an invalid non-empty catalogWriteMode string. Includes field + rawValue, NO secrets. */
export class CatalogWriteModeError extends Error {
  readonly field = "catalogWriteMode";
  readonly rawValue: string;
  constructor(rawValue: string) {
    super(
      `Invalid catalogWriteMode: field=catalogWriteMode rawValue=${JSON.stringify(
        rawValue
      )} (valid: FULL, PRICE_ONLY)`
    );
    this.name = "CatalogWriteModeError";
    this.rawValue = rawValue;
  }
}

/**
 * Resolve the write mode. EXACT semantics:
 *   null | undefined | "" | whitespace-only  -> "FULL"
 *   "FULL"        -> "FULL"
 *   "PRICE_ONLY"  -> "PRICE_ONLY"
 *   any other non-empty string -> throw CatalogWriteModeError
 * (Trim before comparing; comparison is exact-case on the trimmed value.)
 *
 * Non-string, non-null/undefined input -> throw CatalogWriteModeError(String(raw)).
 * Un valor mal tipeado NUNCA cae en silencio a FULL.
 */
export function resolveCatalogWriteMode(raw: unknown): CatalogWriteMode {
  if (raw === null || raw === undefined) return "FULL";
  // Cualquier no-string (que no sea null/undefined) es inválido → fail-loud.
  if (typeof raw !== "string") {
    throw new CatalogWriteModeError(String(raw));
  }
  const trimmed = raw.trim();
  if (trimmed === "") return "FULL";
  if (trimmed === "FULL") return "FULL";
  if (trimmed === "PRICE_ONLY") return "PRICE_ONLY";
  throw new CatalogWriteModeError(trimmed);
}

/** Typed error when PRICE_ONLY sees an incoming SKU that does not already exist in the catalog. */
export class PriceOnlyNewSkuError extends Error {
  readonly reasonCode = "PRICE_ONLY_NEW_SKU_NOT_ALLOWED";
  constructor(sku: string | null) {
    super(`PRICE_ONLY_NEW_SKU_NOT_ALLOWED sku=${JSON.stringify(sku)}`);
    this.name = "PriceOnlyNewSkuError";
  }
}

export interface PriceOnlyUpdate {
  catalogProductId: string;
  wholesalePrice: number | null;
}

/**
 * Pure per-product decision for the PRICE_ONLY path. Given the existing catalog row (or null if not
 * found) and the incoming product, return the price-only update, or THROW PriceOnlyNewSkuError.
 * - incoming.sku null/blank -> throw (no stable identity to price-update).
 * - existing === null (SKU not in catalog) -> throw (PRICE_ONLY must not create new SKUs).
 * - else -> { catalogProductId: existing.id, wholesalePrice: incoming.wholesalePrice==null ? null : Number(incoming.wholesalePrice) }.
 * NOTE: this decision intentionally carries ONLY wholesalePrice — the caller writes exactly
 * {wholesalePrice, lastSeenAt, latestExtractedProductId} and nothing else (all other fields preserved).
 */
export function resolvePriceOnlyUpdate(
  existing: { id: string } | null,
  incoming: { sku: string | null; wholesalePrice: number | null }
): PriceOnlyUpdate {
  const sku = incoming.sku;
  // Sin identidad estable (sku null/blank) no se puede hacer price-update.
  if (sku === null || sku === undefined || String(sku).trim() === "") {
    throw new PriceOnlyNewSkuError(sku ?? null);
  }
  // PRICE_ONLY nunca crea SKUs nuevos.
  if (existing === null) {
    throw new PriceOnlyNewSkuError(sku);
  }
  const wholesalePrice =
    incoming.wholesalePrice === null || incoming.wholesalePrice === undefined
      ? null
      : Number(incoming.wholesalePrice);
  return { catalogProductId: existing.id, wholesalePrice };
}
