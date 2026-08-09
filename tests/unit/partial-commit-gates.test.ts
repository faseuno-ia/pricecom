// 2G-R8-Q2.1-B · gates puros: partición (§4), run health gate (§5), price preflight (§6),
// lifecycle shadow (§8). Sin red, sin DB.
import { describe, it, expect } from "vitest";
import { partitionReconciliation, type PartitionCatalogRow } from "@/lib/catalog/partition-write-set";
import { evaluateRunHealthGate } from "@/lib/catalog/run-health-gate";
import { evaluatePricePreflight } from "@/lib/catalog/price-preflight";
import { computeLifecycleShadow } from "@/lib/catalog/lifecycle-shadow";
import { evaluatePresentWithoutPriceCeiling, MAX_PRESENT_WITHOUT_PRICE_RATIO_EXPECTED } from "@/lib/catalog/run-health-gate";
import type { SkuResult, ObservedVariant } from "@/lib/catalog/sku-reconciliation";

const res = (sku: string, classification: SkuResult["classification"], reason: SkuResult["reason"] = null): SkuResult =>
  ({ sku, classification, reason, evidenceLevel: "NONE" });

describe("§4 · partitionReconciliation", () => {
  it("PRICE_WRITE_SET sólo present-with-price con precio observado persistible; cobertura exacta", () => {
    const rows: PartitionCatalogRow[] = [
      { sku: "A", fichaCanonicalUrl: "x/a", wholesalePrice: 100 },
      { sku: "B", fichaCanonicalUrl: "x/b", wholesalePrice: 50 },
      { sku: "C", fichaCanonicalUrl: "x/c", wholesalePrice: null },
      { sku: "D", fichaCanonicalUrl: "x/d", wholesalePrice: 80 },
    ];
    const results: SkuResult[] = [
      res("A", "SKU_VERIFIED_PRESENT_WITH_PRICE"),
      res("B", "SKU_PRESENT_WITHOUT_PRICE"),
      res("C", "SKU_UNVERIFIED", "RATE_LIMITED"),
      res("D", "SKU_VERIFIED_ABSENT", "ABSENT_IN_BOTH_SITEMAPS"),
    ];
    const observed = new Map<string, ObservedVariant[]>([["x/a", [{ sku: "A", priceNumber: 120 }]]]);
    const p = partitionReconciliation(results, rows, observed);
    expect(p.priceWriteSet).toEqual([{ sku: "A", oldPrice: 100, newPrice: 120, fichaCanonicalUrl: "x/a" }]);
    expect(p.priceWriteSetSize).toBe(1);
    expect(p.presentWithoutPriceCount).toBe(1);
    expect(p.verifiedAbsentCount).toBe(1);
    expect(p.unverifiedCount).toBe(1);
    expect(p.unverifiedCountByReason).toEqual({ RATE_LIMITED: 1 });
    expect(p.fourClassSum).toBe(4);
    expect(p.partitionCoversCatalog).toBe(true);
    expect(p.presentWithPriceButUnpersistable).toEqual([]);
  });

  it("present-with-price sin precio observado persistible → NO entra al write-set (bug detectable)", () => {
    const rows: PartitionCatalogRow[] = [{ sku: "A", fichaCanonicalUrl: "x/a", wholesalePrice: 100 }];
    const results = [res("A", "SKU_VERIFIED_PRESENT_WITH_PRICE")];
    const observed = new Map<string, ObservedVariant[]>([["x/a", [{ sku: "A", priceNumber: 0 }]]]); // no persistible
    const p = partitionReconciliation(results, rows, observed);
    expect(p.priceWriteSetSize).toBe(0);
    expect(p.presentWithPriceButUnpersistable).toEqual(["A"]);
    expect(p.partitionCoversCatalog).toBe(true); // sigue cubriendo (la clase cuenta igual)
  });

  it("NULL_TO_VALID: oldPrice null + newPrice válido entra al write-set", () => {
    const rows: PartitionCatalogRow[] = [{ sku: "C", fichaCanonicalUrl: "x/c", wholesalePrice: null }];
    const results = [res("C", "SKU_VERIFIED_PRESENT_WITH_PRICE")];
    const observed = new Map<string, ObservedVariant[]>([["x/c", [{ sku: "C", priceNumber: 200 }]]]);
    const p = partitionReconciliation(results, rows, observed);
    expect(p.priceWriteSet).toEqual([{ sku: "C", oldPrice: null, newPrice: 200, fichaCanonicalUrl: "x/c" }]);
  });
});

describe("§5 · evaluateRunHealthGate", () => {
  it("PASS cuando todo está bajo los umbrales", () => {
    const r = evaluateRunHealthGate({ dataIncompleteFichaCount: 5, readFailedFichaCount: 5, rateLimitedFichaCount: 5, verifiedDelistedSkuCount: 168, eligibleMappedCatalogSkuCount: 1121 });
    expect(r.abort).toBe(false); // 5==límite (no supera); 168/1121=0.1498<0.15
    expect(r.delistedRatio).toBeCloseTo(0.1498, 3);
  });

  it("RATE_LIMITED=6 aborta aunque las primeras 800 fichas hayan salido perfectas", () => {
    const r = evaluateRunHealthGate({ dataIncompleteFichaCount: 0, readFailedFichaCount: 0, rateLimitedFichaCount: 6, verifiedDelistedSkuCount: 0, eligibleMappedCatalogSkuCount: 1121 });
    expect(r.abort).toBe(true);
    expect(r.reasons.some((x) => x.startsWith("RATE_LIMITED_FICHA_COUNT"))).toBe(true);
  });

  it("delisted ratio > 0.15 aborta", () => {
    const r = evaluateRunHealthGate({ dataIncompleteFichaCount: 0, readFailedFichaCount: 0, rateLimitedFichaCount: 0, verifiedDelistedSkuCount: 200, eligibleMappedCatalogSkuCount: 1121 });
    expect(r.abort).toBe(true);
    expect(r.delistedRatio).toBeGreaterThan(0.15);
  });

  it("denominador 0 → ratio 0, sin división por cero", () => {
    const r = evaluateRunHealthGate({ dataIncompleteFichaCount: 0, readFailedFichaCount: 0, rateLimitedFichaCount: 0, verifiedDelistedSkuCount: 0, eligibleMappedCatalogSkuCount: 0 });
    expect(r.delistedRatio).toBe(0);
    expect(r.abort).toBe(false);
  });

  it("cada conteo por ficha dispara su propia razón", () => {
    expect(evaluateRunHealthGate({ dataIncompleteFichaCount: 6, readFailedFichaCount: 0, rateLimitedFichaCount: 0, verifiedDelistedSkuCount: 0, eligibleMappedCatalogSkuCount: 1121 }).abort).toBe(true);
    expect(evaluateRunHealthGate({ dataIncompleteFichaCount: 0, readFailedFichaCount: 6, rateLimitedFichaCount: 0, verifiedDelistedSkuCount: 0, eligibleMappedCatalogSkuCount: 1121 }).abort).toBe(true);
  });
});

describe("§6 · evaluatePricePreflight", () => {
  const entry = (sku: string, oldP: number | null, newP: number) => ({ sku, oldPrice: oldP, newPrice: newP, fichaCanonicalUrl: null });

  it("§6.1 separación: 47 present-without-price NO disparan NEW_NULL abort; write-set sano → PASS", () => {
    const r = evaluatePricePreflight({
      priceWriteSet: [entry("A", 100, 105), entry("B", 200, 198)],
      presentWithoutPriceCount: 47,
    });
    expect(r.writesetNewNullPriceCount).toBe(0);
    expect(r.priceWriteSetConstructionBug).toBe(false);
    expect(r.presentWithoutPriceCount).toBe(47);
    expect(r.verdict).toBe("PASS");
  });

  it("§6.3 order-of-magnitude shift → ABORT", () => {
    const r = evaluatePricePreflight({ priceWriteSet: [entry("A", 100, 105), entry("X", 10, 500)], presentWithoutPriceCount: 0 });
    expect(r.priceOrderOfMagnitudeShiftCount).toBe(1); // 500/10 = 50 >= 10
    expect(r.verdict).toBe("ABORT");
    expect(r.abortReasons.some((x) => x.startsWith("PRICE_ORDER_OF_MAGNITUDE"))).toBe(true);
  });

  it("§6.4 |mediana| > 0.25 → REVIEW_REQUIRED", () => {
    const r = evaluatePricePreflight({ priceWriteSet: [entry("A", 100, 140), entry("B", 100, 145), entry("C", 100, 138)], presentWithoutPriceCount: 0 });
    expect(Math.abs(r.medianRelativePriceChange)).toBeGreaterThan(0.25);
    expect(r.verdict).toBe("REVIEW_REQUIRED");
  });

  it("NULL_TO_VALID se cuenta aparte y no aborta", () => {
    const r = evaluatePricePreflight({ priceWriteSet: [entry("A", null, 200), entry("B", 100, 102)], presentWithoutPriceCount: 0 });
    expect(r.nullToValidPriceCount).toBe(1);
    expect(r.verdict).toBe("PASS");
  });

  it("forma NO_CHANGE cuando no hay cambios", () => {
    const r = evaluatePricePreflight({ priceWriteSet: [entry("A", 100, 100), entry("B", 50, 50)], presentWithoutPriceCount: 0 });
    expect(r.shape).toBe("NO_CHANGE");
    expect(r.wholesalePriceChangedCount).toBe(0);
    expect(r.verdict).toBe("PASS");
  });

  it("forma SYSTEMATIC_REBASE: todos ~+40% concentrados", () => {
    const ws = Array.from({ length: 20 }, (_, i) => entry("S" + i, 100, 140 + (i % 3))); // ~+0.40, concentrado
    const r = evaluatePricePreflight({ priceWriteSet: ws, presentWithoutPriceCount: 0 });
    expect(r.shape).toBe("SYSTEMATIC_REBASE");
    expect(r.verdict).toBe("REVIEW_REQUIRED"); // mediana ~0.4 > 0.25
  });

  it("forma INCOHERENT: cambios dispersos sin patrón → REVIEW_REQUIRED", () => {
    const ws = [entry("A", 100, 130), entry("B", 100, 80), entry("C", 100, 160), entry("D", 100, 95), entry("E", 100, 200)];
    const r = evaluatePricePreflight({ priceWriteSet: ws, presentWithoutPriceCount: 0 });
    expect(r.shape).toBe("INCOHERENT");
    expect(r.verdict).toBe("REVIEW_REQUIRED");
  });

  it("cambios pequeños centrados → NORMAL_DRIFT + PASS", () => {
    const ws = Array.from({ length: 20 }, (_, i) => entry("S" + i, 100, 100 + ((i % 5) - 2))); // ±2%
    const r = evaluatePricePreflight({ priceWriteSet: ws, presentWithoutPriceCount: 0 });
    expect(r.shape).toBe("NORMAL_DRIFT");
    expect(r.verdict).toBe("PASS");
  });
});

describe("§9 · evaluatePresentWithoutPriceCeiling (techo pre-registrado, reporting-only)", () => {
  it("threshold pre-registrado congelado en 0.15", () => {
    expect(MAX_PRESENT_WITHOUT_PRICE_RATIO_EXPECTED).toBe(0.15);
  });
  it("W40 · baseline 47/1121 ≈ 0.042 → anomaly=false", () => {
    const r = evaluatePresentWithoutPriceCeiling({ presentWithoutPriceCount: 47, eligibleMappedCatalogSkuCount: 1121, verifiedPresentWithPriceCount: 1074 });
    expect(r.ratio).toBeCloseTo(0.042, 3);
    expect(r.anomaly).toBe(false);
  });
  it("W41 · 169/1121 > 0.15 → anomaly=true", () => {
    const r = evaluatePresentWithoutPriceCeiling({ presentWithoutPriceCount: 169, eligibleMappedCatalogSkuCount: 1121, verifiedPresentWithPriceCount: 952 });
    expect(r.ratio).toBeGreaterThan(0.15);
    expect(r.anomaly).toBe(true);
  });
  it("W42 · 1121/1121 = 1 → anomaly=true (caso extremo, write-set vacío)", () => {
    const r = evaluatePresentWithoutPriceCeiling({ presentWithoutPriceCount: 1121, eligibleMappedCatalogSkuCount: 1121, verifiedPresentWithPriceCount: 0 });
    expect(r.ratio).toBe(1);
    expect(r.anomaly).toBe(true);
    expect(r.ratioAmongVerifiedPresent).toBe(1);
  });
  it("denominador 0 → ratio 0 sin dividir por cero", () => {
    const r = evaluatePresentWithoutPriceCeiling({ presentWithoutPriceCount: 0, eligibleMappedCatalogSkuCount: 0, verifiedPresentWithPriceCount: 0 });
    expect(r.ratio).toBe(0);
    expect(r.anomaly).toBe(false);
  });
});

describe("§8 · computeLifecycleShadow", () => {
  it("mapea particiones a would-pause; total = 5 categorías; unmappable/unknown aparte; writes=0", () => {
    const partition = {
      priceWriteSet: [], priceWriteSetSize: 900,
      presentWithoutPriceCount: 47,
      verifiedAbsentCount: 0,
      unverifiedCount: 12,
      unverifiedCountByReason: { DATA_INCOMPLETE: 7, READ_FAILED: 1, RATE_LIMITED: 1, UNMAPPABLE_MAPPING: 1, EVIDENCE_CONFLICT: 2 },
      totalCatalogRows: 1121, fourClassSum: 1121, partitionCoversCatalog: true, presentWithPriceButUnpersistable: [],
    };
    const s = computeLifecycleShadow(partition);
    expect(s.wouldPausePriceNotPublished).toBe(47);
    expect(s.wouldPauseDataIncomplete).toBe(7);
    expect(s.wouldPauseReadFailed).toBe(1);
    expect(s.wouldPauseRateLimited).toBe(1);
    expect(s.wouldPauseDelisted).toBe(0);
    expect(s.unmappableCount).toBe(1);
    expect(s.unknownCount).toBe(2); // EVIDENCE_CONFLICT
    expect(s.totalWouldPause).toBe(56); // 47+7+1+1+0
    expect(s.wouldReactivate).toBe(0);
    expect(s.lifecycleShadowWrites).toBe(0);
  });
});
