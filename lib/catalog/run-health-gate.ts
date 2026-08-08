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
