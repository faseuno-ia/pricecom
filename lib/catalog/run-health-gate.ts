// 2G-R8-Q2.1-B · §5 — RUN HEALTH GATE. PURO. Corta la corrida ANTES de cualquier escritura si la
// TASA de fallas de captura o de bajas es anormal: una falla masiva es evidencia sobre NUESTRA
// capacidad de observación, no sobre cientos de productos del proveedor.
//
// Unidad de errores de captura: FICHA. Unidad de delisting: SKU.
// Límites pre-registrados (PROHIBIDO subirlos para dejar pasar una corrida):

export const MAX_DATA_INCOMPLETE_FICHA_COUNT = 5;
export const MAX_READ_FAILED_FICHA_COUNT = 5;
export const MAX_RATE_LIMITED_FICHA_COUNT = 5;
export const MAX_DELISTED_RATIO = 0.15;

// 2G-R8-Q2.1-B PRE-PR-R2 · §9 — TECHO PRE-REGISTRADO de SKU_PRESENT_WITHOUT_PRICE. Congelado AHORA
// (baseline 47/1121≈0.042). Ratio = present-without-price / eligible-mapped-catalog-skus. NO está
// cableado al control-flow de Q2.1-B (lifecycle es SHADOW_ONLY): sólo se calcula y reporta. Su efecto
// pre-registrado es BLOQUEAR el avance a Q2.1-C/D (enforcement) hasta investigar, NO abortar el price
// shadow ni invalidar precios válidos del PRICE_WRITE_SET.
export const MAX_PRESENT_WITHOUT_PRICE_RATIO_EXPECTED = 0.15;

export interface PresentWithoutPriceCeiling {
  ratio: number;
  anomaly: boolean;
  /** ratio entre los VERIFIED_PRESENT (with-price + without-price), diagnóstico. */
  ratioAmongVerifiedPresent: number;
}

export function evaluatePresentWithoutPriceCeiling(input: {
  presentWithoutPriceCount: number;
  eligibleMappedCatalogSkuCount: number;
  verifiedPresentWithPriceCount: number;
}): PresentWithoutPriceCeiling {
  const denomCatalog = input.eligibleMappedCatalogSkuCount;
  const ratio = denomCatalog > 0 ? input.presentWithoutPriceCount / denomCatalog : 0;
  const verifiedPresent = input.verifiedPresentWithPriceCount + input.presentWithoutPriceCount;
  const ratioAmongVerifiedPresent = verifiedPresent > 0 ? input.presentWithoutPriceCount / verifiedPresent : 0;
  return { ratio, anomaly: ratio > MAX_PRESENT_WITHOUT_PRICE_RATIO_EXPECTED, ratioAmongVerifiedPresent };
}

export interface RunHealthGateInput {
  dataIncompleteFichaCount: number;
  readFailedFichaCount: number;
  rateLimitedFichaCount: number;
  verifiedDelistedSkuCount: number;
  /** SKUs mapeables (excluye unmappable/ambiguos). Denominador del ratio de delisting. */
  eligibleMappedCatalogSkuCount: number;
}

export interface RunHealthGateResult {
  abort: boolean;
  delistedRatio: number;
  /** Razones concretas que dispararon el abort (vacío si PASS). */
  reasons: string[];
}

/**
 * Evalúa el gate. `abort=true` ⇒ PRICE_WRITES=0, LIFECYCLE_WRITES=0, preview=DIAGNOSTIC_ONLY.
 * El ratio usa denominador seguro: si eligibleMappedCatalogSkuCount es 0, ratio=0 (no divide por 0)
 * y sólo los conteos por ficha pueden abortar.
 */
export function evaluateRunHealthGate(input: RunHealthGateInput): RunHealthGateResult {
  const reasons: string[] = [];
  if (input.dataIncompleteFichaCount > MAX_DATA_INCOMPLETE_FICHA_COUNT) {
    reasons.push(`DATA_INCOMPLETE_FICHA_COUNT=${input.dataIncompleteFichaCount}>${MAX_DATA_INCOMPLETE_FICHA_COUNT}`);
  }
  if (input.readFailedFichaCount > MAX_READ_FAILED_FICHA_COUNT) {
    reasons.push(`READ_FAILED_FICHA_COUNT=${input.readFailedFichaCount}>${MAX_READ_FAILED_FICHA_COUNT}`);
  }
  if (input.rateLimitedFichaCount > MAX_RATE_LIMITED_FICHA_COUNT) {
    reasons.push(`RATE_LIMITED_FICHA_COUNT=${input.rateLimitedFichaCount}>${MAX_RATE_LIMITED_FICHA_COUNT}`);
  }
  const denom = input.eligibleMappedCatalogSkuCount;
  const delistedRatio = denom > 0 ? input.verifiedDelistedSkuCount / denom : 0;
  if (delistedRatio > MAX_DELISTED_RATIO) {
    reasons.push(`DELISTED_RATIO=${delistedRatio.toFixed(4)}>${MAX_DELISTED_RATIO}`);
  }
  return { abort: reasons.length > 0, delistedRatio, reasons };
}
