// 2G-R5D — Guard PURO pre-write contra regresión de precios (priced→null).
//
// Barrera fail-closed que corre en el worker DESPUÉS de scraper.run() y ANTES de cualquier
// escritura comercial (ExtractedProduct.createMany, upsertCatalogProducts, Provider.lastExtractionAt,
// ExtractionComparison). Simula el writeset de precio del camino productivo real:
//
//   PATH 1 (directo): upsertCatalogProducts hace `catalogProduct.update({data: supplierDataBase})`
//     con wholesalePrice = incoming (null si null) → PUEDE degradar un precio existente a null.
//   PATH 2 (propagación a hijos OWN): updateMany({data:{wholesalePrice}}) SÓLO cuando el incoming
//     `!= null` (upsert-catalog-products.ts:378) → estructuralmente NUNCA escribe null a un hijo.
//     Por lo tanto la propagación no puede causar priced→null (modelado fiel: 0).
//
// Sin I/O, sin DB, sin browser: recibe el estado existente ya leído y los productos entrantes.
// Semántica de "precio válido" compartida con la selección de groupSkuFirst (número finito > 0).

/** Precio mayorista VÁLIDO: número finito y > 0 (misma semántica que la selección de groupSkuFirst). */
export function isValidWholesalePrice(v: unknown): boolean {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

export interface ExistingCatalogRow {
  id: string;
  sku: string | null;
  wholesalePrice: number | null;
}
/** Hijo con stockSource=OWN que apunta a un parent por sourceCatalogProductId. */
export interface OwnChildRow {
  id: string;
  sourceCatalogProductId: string | null;
  wholesalePrice: number | null;
}
export interface IncomingProductRow {
  sku: string | null;
  wholesalePrice: number | null;
}

export interface PreWritePriceAnalysis {
  incomingRowCount: number;
  incomingValidPriceCount: number;
  incomingInvalidOrNullPriceCount: number;
  existingMatchedRowCount: number;
  existingPricedCount: number;
  directPricedToNullCount: number;
  propagatedOwnChildPricedToNullCount: number;
  pricedToNullCount: number; // unique(direct ∪ propagated) por CatalogProduct.id
  newSkuWithValidPriceCount: number;
  newSkuWithNullPriceCount: number;
  ownChildRowsPotentiallyAffected: number;
  pricedToNullSkuSample: string[]; // hasta 20 SKUs sanitizados; nunca precios
}

const SAMPLE_MAX = 20;
const trimmedSku = (s: string | null | undefined): string | null => {
  const t = typeof s === "string" ? s.trim() : "";
  return t.length > 0 ? t : null;
};

/**
 * Analiza el writeset de precio que el upsert productivo ejecutaría. Puro y determinístico.
 * `existing`/`ownChildren` ya fueron leídos read-only por el caller (scope userId+providerId).
 */
export function analyzePreWritePriceRegression(args: {
  existing: ExistingCatalogRow[];
  ownChildren: OwnChildRow[];
  incoming: IncomingProductRow[];
}): PreWritePriceAnalysis {
  const existingBySku = new Map<string, ExistingCatalogRow>();
  for (const r of args.existing) {
    const k = trimmedSku(r.sku);
    if (k !== null && !existingBySku.has(k)) existingBySku.set(k, r);
  }
  const childrenByParent = new Map<string, OwnChildRow[]>();
  for (const c of args.ownChildren) {
    const pid = c.sourceCatalogProductId;
    if (!pid) continue;
    (childrenByParent.get(pid) ?? childrenByParent.set(pid, []).get(pid)!).push(c);
  }

  let incomingRowCount = 0, incomingValidPriceCount = 0, incomingInvalidOrNullPriceCount = 0;
  let existingMatchedRowCount = 0, existingPricedCount = 0;
  let newSkuWithValidPriceCount = 0, newSkuWithNullPriceCount = 0;
  let ownChildRowsPotentiallyAffected = 0;
  const directNullIds = new Set<string>();
  const propagatedNullIds = new Set<string>();
  const pricedToNullSkus: string[] = [];

  for (const inc of args.incoming) {
    const sku = trimmedSku(inc.sku);
    if (sku === null) continue; // productos sin SKU: keying no-sku (fuera del alcance de precio directo)
    incomingRowCount++;
    const incomingValid = isValidWholesalePrice(inc.wholesalePrice);
    if (incomingValid) incomingValidPriceCount++; else incomingInvalidOrNullPriceCount++;

    const ex = existingBySku.get(sku);
    if (!ex) {
      if (incomingValid) newSkuWithValidPriceCount++; else newSkuWithNullPriceCount++;
      continue;
    }
    existingMatchedRowCount++;
    const existingValid = isValidWholesalePrice(ex.wholesalePrice);
    if (existingValid) existingPricedCount++;

    // PATH 1 · update directo del parent: escribe el incoming (null si null).
    if (existingValid && !incomingValid) {
      directNullIds.add(ex.id);
      if (pricedToNullSkus.length < SAMPLE_MAX) pricedToNullSkus.push(sku);
    }

    // PATH 2 · propagación a hijos OWN: el upsert real SÓLO propaga cuando incoming != null
    // (wholesalePrice válido). En ese caso el hijo recibe un precio válido → jamás null.
    // Cuando incoming es null/invalid la propagación se SALTEA → el hijo se preserva.
    // ⇒ propagación nunca causa priced→null. Contamos hijos afectados sólo cuando propaga (válido).
    const children = childrenByParent.get(ex.id) ?? [];
    if (incomingValid) ownChildRowsPotentiallyAffected += children.length; // reciben precio válido, no null
    // (Ninguna rama agrega a propagatedNullIds: es estructuralmente imposible en el upsert vigente.)
  }

  const unionNull = new Set<string>([...directNullIds, ...propagatedNullIds]);
  return {
    incomingRowCount,
    incomingValidPriceCount,
    incomingInvalidOrNullPriceCount,
    existingMatchedRowCount,
    existingPricedCount,
    directPricedToNullCount: directNullIds.size,
    propagatedOwnChildPricedToNullCount: propagatedNullIds.size,
    pricedToNullCount: unionNull.size,
    newSkuWithValidPriceCount,
    newSkuWithNullPriceCount,
    ownChildRowsPotentiallyAffected,
    pricedToNullSkuSample: pricedToNullSkus,
  };
}

export type PreWritePriceGuardCode =
  | "PRE_WRITE_PRICE_REGRESSION_DETECTED"
  | "LOGIN_GATED_EXTRACTION_HAS_ZERO_VALID_PRICES";

/** Error tipado, sanitizado (código + conteos + ids de contexto; NUNCA precios/credenciales). */
export class PreWritePriceGuardError extends Error {
  readonly code: PreWritePriceGuardCode;
  readonly analysis: PreWritePriceAnalysis;
  constructor(code: PreWritePriceGuardCode, analysis: PreWritePriceAnalysis, ctx: { providerId: string; jobId: string }) {
    super(
      `${code} providerId=${ctx.providerId} jobId=${ctx.jobId} ` +
        `pricedToNull=${analysis.pricedToNullCount} directPricedToNull=${analysis.directPricedToNullCount} ` +
        `propagatedPricedToNull=${analysis.propagatedOwnChildPricedToNullCount} ` +
        `existingPriced=${analysis.existingPricedCount} incomingRows=${analysis.incomingRowCount} ` +
        `incomingValidPrice=${analysis.incomingValidPriceCount} incomingNullPrice=${analysis.incomingInvalidOrNullPriceCount} ` +
        `newNullSku=${analysis.newSkuWithNullPriceCount} pricedToNullSkuSample=${JSON.stringify(analysis.pricedToNullSkuSample)}`,
    );
    this.name = "PreWritePriceGuardError";
    this.code = code;
    this.analysis = analysis;
  }
}

/**
 * Contrato fail-closed (dos reglas INDEPENDIENTES). Lanza si alguna se viola; si pasa, no hace nada.
 *   1. universal: cualquier priced→null → PRE_WRITE_PRICE_REGRESSION_DETECTED.
 *   2. login-gated: requiresLogin && incomingRows>0 && incomingValidPrice==0 → LOGIN_GATED_EXTRACTION_HAS_ZERO_VALID_PRICES.
 * Los SKUs nuevos con precio null NO cuentan como priced→null (no degradan una fila existente).
 */
export function assertNoPreWritePriceRegression(
  analysis: PreWritePriceAnalysis,
  requiresLogin: boolean,
  ctx: { providerId: string; jobId: string },
): void {
  if (analysis.pricedToNullCount > 0) {
    throw new PreWritePriceGuardError("PRE_WRITE_PRICE_REGRESSION_DETECTED", analysis, ctx);
  }
  if (requiresLogin && analysis.incomingRowCount > 0 && analysis.incomingValidPriceCount === 0) {
    throw new PreWritePriceGuardError("LOGIN_GATED_EXTRACTION_HAS_ZERO_VALID_PRICES", analysis, ctx);
  }
}

/** Lector read-only del catálogo (inyectable: prisma en el worker, mock en tests). */
export interface PreWriteCatalogReader {
  findExisting: (userId: string, providerId: string, skus: string[]) => Promise<ExistingCatalogRow[]>;
}

// §5 (R2) — La propagación a hijos OWN del upsert real SÓLO escribe con precio != null
// (upsert-catalog-products.ts:378) ⇒ un null NUNCA produce priced→null en un hijo OWN.
// `NULL_PROPAGATION_TO_OWN_CHILDREN_POSSIBLE = false`. Por eso el camino productivo NO consulta
// hijos OWN (evita un query potencialmente grande sin transición posible); el analizador mantiene
// el parámetro `ownChildren` sólo para congelar esa conclusión en tests.
export const NULL_PROPAGATION_TO_OWN_CHILDREN_POSSIBLE = false;

/** Error de resolución de tenant (userId) — fail-closed antes de cualquier escritura comercial. */
export class PreWriteGuardTenantError extends Error {
  readonly code: "PRE_WRITE_PRICE_GUARD_USER_ID_MISSING" | "EXTRACTION_JOB_PROVIDER_USER_MISMATCH";
  constructor(
    code: "PRE_WRITE_PRICE_GUARD_USER_ID_MISSING" | "EXTRACTION_JOB_PROVIDER_USER_MISMATCH",
    ctx: { providerId: string; jobId: string },
  ) {
    super(`${code} providerId=${ctx.providerId} jobId=${ctx.jobId}`);
    this.name = "PreWriteGuardTenantError";
    this.code = code;
  }
}

/**
 * Orquestación del guard para el worker (una única llamada, inline antes de la primera escritura
 * comercial). Resuelve el tenant FAIL-CLOSED, lee el estado existente read-only, analiza y ASERTA:
 *
 *   TENANT (§2 · autoridad = job.userId; provider.userId es SÓLO testigo de consistencia):
 *     - si falta job.userId (null/undefined/blank) → PRE_WRITE_PRICE_GUARD_USER_ID_MISSING;
 *     - si provider.userId existe y difiere de job.userId → EXTRACTION_JOB_PROVIDER_USER_MISMATCH;
 *     - effectiveUserId = job.userId (SIN fallback a provider.userId).
 *   El catálogo se lee con effectiveUserId, la MISMA autoridad que usa upsertCatalogProducts.
 *
 *   PRECIO (dos reglas independientes): priced→null y login-gated sin precios (ver
 *   assertNoPreWritePriceRegression). Los checks de tenant corren ANTES de leer el catálogo, así
 *   que un tenant inválido lanza sin tocar la DB.
 *
 * Lanza PreWriteGuardTenantError / PreWritePriceGuardError; el caller (worker) lo propaga a su
 * catch histórico → markFailed. Nunca ejecuta escrituras comerciales.
 */
export async function assertNoPreWritePriceRegressionForExtraction(
  reader: PreWriteCatalogReader,
  args: {
    userId: string | null | undefined; // job.userId — ÚNICA autoridad de tenant
    providerUserId?: string | null; // provider.userId — SÓLO testigo de consistencia (no reemplaza)
    providerId: string;
    requiresLogin: boolean;
    jobId: string;
    products: IncomingProductRow[];
    onLog?: (level: "DEBUG" | "INFO" | "WARN" | "ERROR", msg: string) => Promise<void> | void;
  },
): Promise<PreWritePriceAnalysis> {
  const ctx = { providerId: args.providerId, jobId: args.jobId };
  // 1 · Tenant FAIL-CLOSED. job.userId es la autoridad; provider.userId es sólo testigo (no fallback).
  const jobUserId = typeof args.userId === "string" ? args.userId.trim() : "";
  if (!jobUserId) throw new PreWriteGuardTenantError("PRE_WRITE_PRICE_GUARD_USER_ID_MISSING", ctx);
  const providerUserId = typeof args.providerUserId === "string" ? args.providerUserId.trim() : "";
  if (providerUserId && providerUserId !== jobUserId) {
    throw new PreWriteGuardTenantError("EXTRACTION_JOB_PROVIDER_USER_MISMATCH", ctx);
  }
  const effectiveUserId = jobUserId; // NO se hace fallback a provider.userId.

  const incoming = args.products ?? [];
  const skus = Array.from(
    new Set(incoming.map((p) => (typeof p.sku === "string" ? p.sku.trim() : "")).filter((s) => s.length > 0)),
  );
  const existing = skus.length ? await reader.findExisting(effectiveUserId, args.providerId, skus) : [];
  // ownChildren=[] a propósito: la propagación nunca escribe null (ver NULL_PROPAGATION_TO_OWN_CHILDREN_POSSIBLE).
  const analysis = analyzePreWritePriceRegression({ existing, ownChildren: [], incoming });
  if (args.onLog) {
    const wouldFail =
      analysis.pricedToNullCount > 0 ||
      (args.requiresLogin && analysis.incomingRowCount > 0 && analysis.incomingValidPriceCount === 0);
    await args.onLog(
      "INFO",
      `[PreWritePriceGuard] existingPriced=${analysis.existingPricedCount} incomingRows=${analysis.incomingRowCount} ` +
        `incomingValidPrice=${analysis.incomingValidPriceCount} incomingNullPrice=${analysis.incomingInvalidOrNullPriceCount} ` +
        `directPricedToNull=${analysis.directPricedToNullCount} propagatedPricedToNull=${analysis.propagatedOwnChildPricedToNullCount} ` +
        `newNullSku=${analysis.newSkuWithNullPriceCount} decision=${wouldFail ? "FAIL" : "PASS"}`,
    );
  }
  assertNoPreWritePriceRegression(analysis, args.requiresLogin, { providerId: args.providerId, jobId: args.jobId });
  return analysis;
}
