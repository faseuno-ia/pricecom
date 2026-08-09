// 2G-R8-Q2.1-B · §3/§4 — ORQUESTACIÓN del partial-commit shadow. Orden de fases INVIOLABLE; ninguna
// escritura antes de walk/reconciliación/health/preflight. La lógica de decisión es pura y testeable;
// los efectos de DB (fenced tx, terminal) se inyectan para poder mockearlos en tests unitarios.
//
// ORDEN: walk → assemble → reconcile → partition → lifecycle shadow (SIEMPRE) → run health gate →
// price preflight → (sólo si health PASS ∧ preflight PASS) fenced commercial write → terminal.

import type { SkuFirstPartialResult, ScrapedProduct } from "../../lib/scraper/scraper.service";
import { assembleReconcileInput, type AssemblyCatalogRow } from "../../lib/catalog/reconciliation-assembly";
import { reconcileSkus } from "../../lib/catalog/sku-reconciliation";
import { partitionReconciliation } from "../../lib/catalog/partition-write-set";
import { computeLifecycleShadow, type LifecycleShadowResult } from "../../lib/catalog/lifecycle-shadow";
import { evaluateRunHealthGate, evaluatePresentWithoutPriceCeiling, type RunHealthGateResult, type PresentWithoutPriceCeiling } from "../../lib/catalog/run-health-gate";
import { evaluatePricePreflight, type PricePreflightResult } from "../../lib/catalog/price-preflight";
import type { PartialPriceWriteEntry } from "../../lib/catalog/price-only-partial-write";

export type PartialCommitClassification =
  | "GREEN_FIRST_PRODUCTIVE_PRICE_WRITE"
  | "GREEN_FAIL_CLOSED_ABNORMAL_FAILURE_RATE"
  | "STOP_UNSAFE_PRICE_MAGNITUDE"
  | "GREEN_WALK_PRICE_REVIEW_REQUIRED_NO_WRITE"
  | "RED_LEASE_REGRESSION"
  | "RED_WRITE_POLICY_VIOLATION"
  | "STOP_PARTITION_DOES_NOT_COVER_CATALOG";

export type LifecyclePreviewStatus = "DIAGNOSTIC_ONLY" | "VALID_SHADOW_NO_PRICE_WRITE" | "VALID_SHADOW_WITH_PRICE_WRITE";

/** Decisión PURA a partir de las compuertas. No escribe. */
export function decidePartialCommit(health: RunHealthGateResult, preflight: PricePreflightResult): {
  authorizeWrite: boolean;
  classification: PartialCommitClassification;
  lifecyclePreviewStatus: LifecyclePreviewStatus;
} {
  if (health.abort) {
    return { authorizeWrite: false, classification: "GREEN_FAIL_CLOSED_ABNORMAL_FAILURE_RATE", lifecyclePreviewStatus: "DIAGNOSTIC_ONLY" };
  }
  if (preflight.verdict === "ABORT") {
    return { authorizeWrite: false, classification: "STOP_UNSAFE_PRICE_MAGNITUDE", lifecyclePreviewStatus: "VALID_SHADOW_NO_PRICE_WRITE" };
  }
  if (preflight.verdict === "REVIEW_REQUIRED") {
    return { authorizeWrite: false, classification: "GREEN_WALK_PRICE_REVIEW_REQUIRED_NO_WRITE", lifecyclePreviewStatus: "VALID_SHADOW_NO_PRICE_WRITE" };
  }
  return { authorizeWrite: true, classification: "GREEN_FIRST_PRODUCTIVE_PRICE_WRITE", lifecyclePreviewStatus: "VALID_SHADOW_WITH_PRICE_WRITE" };
}

export interface FencedCommitInput {
  /** TODAS las observaciones válidas (ScrapedProduct completo) → ExtractedProduct (política OBSERVATIONS, §addendum A). */
  observations: ScrapedProduct[];
  /** SÓLE el PRICE_WRITE_SET (N) — única autoridad de precio. */
  priceWriteSkus: Array<{ sku: string; newPrice: number }>;
  completionStats: Record<string, number>;
}
export interface FencedCommitResult { committed: boolean; finalizationMs: number; writtenCount: number }

export interface PartialCommitShadowDeps {
  runReconciliation: () => Promise<SkuFirstPartialResult>;
  loadCatalogRows: () => Promise<AssemblyCatalogRow[]>;
  /** Ejecuta la tx fenced (CAS · D(writeset) · createMany EP(observations) · writePriceOnlyExplicit(writeset)
   *  · provider · terminal). Debe ser atómica. Lanza si el lease se pierde (el caller clasifica RED). */
  fencedCommit: (input: FencedCommitInput) => Promise<FencedCommitResult>;
  /** Terminal COMPLETED fenced SIN escritura comercial (health/preflight/review block). Retorna owned. */
  markCompletedNoWrite: (completionStats: Record<string, number>) => Promise<boolean>;
  onLog: (level: "DEBUG" | "INFO" | "WARN" | "ERROR", msg: string) => Promise<void>;
  nowMs: () => number;
}

export interface PartialCommitShadowReport {
  classification: PartialCommitClassification;
  lifecyclePreviewStatus: LifecyclePreviewStatus;
  authorizeWrite: boolean;
  fencedTransactionOpened: boolean;
  priceWriteSetSize: number;
  presentWithoutPriceCount: number;
  verifiedAbsentCount: number;
  unverifiedCount: number;
  providerNewSkuCount: number;
  partitionCoversCatalog: boolean;
  health: RunHealthGateResult;
  preflight: PricePreflightResult;
  lifecycle: LifecycleShadowResult;
  fenced?: FencedCommitResult;
  wholesalePriceWrittenCount: number;
  /** §9 · techo present-without-price (reporting-only; NO cablea el control-flow de Q2.1-B). */
  presentWithoutPriceCeiling: PresentWithoutPriceCeiling;
}

/**
 * Corre el orden de fases y devuelve el reporte. NUNCA escribe fuera de fencedCommit. Si la partición
 * no cubre el catálogo → STOP (no abre transacción). Si health o preflight bloquean → cero escritura,
 * lifecycle calculado igual. Si ambos pasan → fencedCommit.
 */
export async function runPartialCommitShadow(deps: PartialCommitShadowDeps): Promise<PartialCommitShadowReport> {
  // FASE 1-6 · walk + observación (dentro de runReconciliation) — NINGUNA escritura.
  const partial = await deps.runReconciliation();
  const catalogRows = await deps.loadCatalogRows();

  // FASE 7-8 · assemble + classifier.
  const { input, fichaOutcomeCounts, eligibleMappedCatalogSkuCount } = assembleReconcileInput(
    {
      products: partial.products.map((p) => ({ sku: p.sku, productUrl: p.productUrl, wholesalePrice: p.wholesalePrice })),
      fichaObservations: partial.fichaObservations.map((o) => ({ url: o.url, outcome: o.outcome, variantSetComplete: o.variantSetComplete })),
      fichaQuarantine: partial.fichaQuarantine,
      sitemapStartUrls: partial.sitemapStartUrls,
      sitemapEndUrls: partial.sitemapEndUrls,
      sitemapStartOk: partial.sitemapStartOk,
      sitemapEndOk: partial.sitemapEndOk,
    },
    catalogRows,
  );
  const reconciled = reconcileSkus(input);

  // FASE 9-10 · particiones (provider-discovery + catálogo).
  const partition = partitionReconciliation(reconciled.results, input.catalogRows, input.observedVariants);
  if (!partition.partitionCoversCatalog) {
    await deps.onLog("ERROR", `[PartialCommit] PARTITION_DOES_NOT_COVER_CATALOG sum=${partition.fourClassSum} total=${partition.totalCatalogRows}`);
    // STOP: no abrir transacción. Se marca terminal sin escritura.
    const lifecycle = computeLifecycleShadow(partition);
    await deps.markCompletedNoWrite({ totalProducts: partition.totalCatalogRows, productsWithPrice: 0, productsWithoutPrice: partition.presentWithoutPriceCount, productsWithoutSku: 0 });
    return buildReport("STOP_PARTITION_DOES_NOT_COVER_CATALOG", "DIAGNOSTIC_ONLY", false, false, partition, reconciled.providerDiscovery.providerNewSkuCount,
      evaluateRunHealthGate({ dataIncompleteFichaCount: fichaOutcomeCounts.dataIncomplete, readFailedFichaCount: fichaOutcomeCounts.readFailed, rateLimitedFichaCount: fichaOutcomeCounts.rateLimited, verifiedDelistedSkuCount: partition.verifiedAbsentCount, eligibleMappedCatalogSkuCount }),
      evaluatePricePreflight({ priceWriteSet: partition.priceWriteSet, presentWithoutPriceCount: partition.presentWithoutPriceCount }), lifecycle, 0, eligibleMappedCatalogSkuCount);
  }

  // FASE 11 · LIFECYCLE SHADOW (SIEMPRE, antes de las compuertas).
  const lifecycle = computeLifecycleShadow(partition);

  // FASE 12 · RUN HEALTH GATE.
  const health = evaluateRunHealthGate({
    dataIncompleteFichaCount: fichaOutcomeCounts.dataIncomplete,
    readFailedFichaCount: fichaOutcomeCounts.readFailed,
    rateLimitedFichaCount: fichaOutcomeCounts.rateLimited,
    verifiedDelistedSkuCount: partition.verifiedAbsentCount,
    eligibleMappedCatalogSkuCount,
  });

  // FASE 13 · PRICE PREFLIGHT.
  const preflight = evaluatePricePreflight({ priceWriteSet: partition.priceWriteSet, presentWithoutPriceCount: partition.presentWithoutPriceCount });

  // OBS1 · artefacto de REVISIÓN de precios persistido (observabilidad; onLog → ExtractionLog + consola,
  // fuera de la fenced tx). Emitido DESPUÉS del preflight y ANTES de la decisión/return/fenced tx, para
  // que sobreviva a REVIEW_REQUIRED (que NO abre tx ni persiste ExtractedProduct). Los valores provienen
  // EXACTAMENTE del preflight/partición usados para decidir (una sola fuente de verdad; sin recálculo).
  // Si el health gate abortó, la muestra NO es el factor decisorio → no se fabrica (reason=HEALTH_GATE_ABORT).
  if (health.abort) {
    await deps.onLog("INFO", `[PartialCommitPriceSample] ${JSON.stringify({ schemaVersion: 1, priceSampleComputed: false, reason: "HEALTH_GATE_ABORT" })}`);
  } else {
    const pwp = evaluatePresentWithoutPriceCeiling({ presentWithoutPriceCount: partition.presentWithoutPriceCount, eligibleMappedCatalogSkuCount, verifiedPresentWithPriceCount: partition.priceWriteSetSize });
    await deps.onLog("INFO", `[PartialCommitPriceSample] ${JSON.stringify({
      schemaVersion: 1,
      priceSampleComputed: true,
      pricePlausibilityVerdict: preflight.verdict,
      priceChangeShape: preflight.shape,
      priceWriteSetSize: partition.priceWriteSetSize,
      wholesalePriceChangedCount: preflight.wholesalePriceChangedCount,
      medianRelativeChange: preflight.medianRelativePriceChange,
      p95AbsRelativeChange: preflight.p95AbsRelativePriceChange,
      iqrRelativeChange: preflight.iqrRelativePriceChange,
      shareWithin5PctOfMedian: preflight.shareWithin5pctOfMedianChange,
      shareNegative: preflight.shareNegativeChange,
      sharePositive: preflight.sharePositiveChange,
      rowsChangedMoreThan50Pct: preflight.rowsChangedMoreThan50Pct,
      rowsChangedMoreThan200Pct: preflight.rowsChangedMoreThan200Pct,
      priceOrderOfMagnitudeShiftCount: preflight.priceOrderOfMagnitudeShiftCount,
      nullToValidPriceCount: preflight.nullToValidPriceCount,
      writesetExistingPricedToNullCount: preflight.writesetExistingPricedToNullCount,
      writesetNewNullPriceCount: preflight.writesetNewNullPriceCount,
      writesetNewNonPositivePriceCount: preflight.writesetNewNonpositivePriceCount,
      presentWithoutPriceCount: preflight.presentWithoutPriceCount,
      presentWithoutPriceRatioCatalog: pwp.ratio,
      priceChangeSampleMax20: preflight.priceChangeSampleMax20,
      top5Outliers: preflight.top5OutliersByAbsRelChange,
    })}`);
  }

  const decision = decidePartialCommit(health, preflight);
  await deps.onLog("INFO", `[PartialCommit] decision=${decision.classification} authorizeWrite=${decision.authorizeWrite} writeSet=${partition.priceWriteSetSize} health.abort=${health.abort} preflight=${preflight.verdict}`);

  if (!decision.authorizeWrite) {
    // FASE 14 (no-write) · cero escritura comercial; lifecycle ya calculado.
    await deps.markCompletedNoWrite({ totalProducts: partition.totalCatalogRows, productsWithPrice: 0, productsWithoutPrice: partition.presentWithoutPriceCount, productsWithoutSku: 0 });
    return buildReport(decision.classification, decision.lifecyclePreviewStatus, false, false, partition, reconciled.providerDiscovery.providerNewSkuCount, health, preflight, lifecycle, 0, eligibleMappedCatalogSkuCount);
  }

  // FASE 14 (write) · transacción fenced. observations = TODAS las válidas; price write = SÓLO N.
  const priceWriteSkus = partition.priceWriteSet.map((e) => ({ sku: e.sku, newPrice: e.newPrice }));
  const completionStats = { totalProducts: partition.totalCatalogRows, productsWithPrice: partition.priceWriteSetSize, productsWithoutPrice: partition.presentWithoutPriceCount, productsWithoutSku: 0 };
  const fenced = await deps.fencedCommit({ observations: partial.products, priceWriteSkus, completionStats });
  const report = buildReport(decision.classification, decision.lifecyclePreviewStatus, true, fenced.committed, partition, reconciled.providerDiscovery.providerNewSkuCount, health, preflight, lifecycle, fenced.writtenCount, eligibleMappedCatalogSkuCount);
  report.fenced = fenced;
  return report;
}

function buildReport(
  classification: PartialCommitClassification,
  lifecyclePreviewStatus: LifecyclePreviewStatus,
  fencedTransactionOpened: boolean,
  _committed: boolean,
  partition: ReturnType<typeof partitionReconciliation>,
  providerNewSkuCount: number,
  health: RunHealthGateResult,
  preflight: PricePreflightResult,
  lifecycle: LifecycleShadowResult,
  wholesalePriceWrittenCount: number,
  eligibleMappedCatalogSkuCount: number,
): PartialCommitShadowReport {
  return {
    classification,
    lifecyclePreviewStatus,
    authorizeWrite: fencedTransactionOpened,
    fencedTransactionOpened,
    priceWriteSetSize: partition.priceWriteSetSize,
    presentWithoutPriceCount: partition.presentWithoutPriceCount,
    verifiedAbsentCount: partition.verifiedAbsentCount,
    unverifiedCount: partition.unverifiedCount,
    providerNewSkuCount,
    partitionCoversCatalog: partition.partitionCoversCatalog,
    health, preflight, lifecycle, wholesalePriceWrittenCount,
    presentWithoutPriceCeiling: evaluatePresentWithoutPriceCeiling({
      presentWithoutPriceCount: partition.presentWithoutPriceCount,
      eligibleMappedCatalogSkuCount,
      verifiedPresentWithPriceCount: partition.priceWriteSetSize,
    }),
  };
}

// Membresía del write-set para armar los PartialPriceWriteEntry (el worker completa extractedProductId).
export type { PartialPriceWriteEntry };
