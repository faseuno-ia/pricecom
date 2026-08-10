// 2G-R8-Q2.1-B · orquestación del shadow: orden de fases, decisión, write-set-only, aislamiento de
// SKUs nuevos, bloqueos de compuertas. Deps de DB mockeadas (sin red, sin DB).
import { describe, it, expect, vi } from "vitest";
import {
  runPartialCommitShadow,
  decidePartialCommit,
  type PartialCommitShadowDeps,
  type FencedCommitInput,
} from "../../worker/src/partial-commit-shadow";
import type { SkuFirstPartialResult } from "@/lib/scraper/scraper.service";
import type { AssemblyCatalogRow } from "@/lib/catalog/reconciliation-assembly";

const FA = "https://differenttouch.com.ar/productos/a";
const canonA = "differenttouch.com.ar/productos/a";

function makeDeps(partial: SkuFirstPartialResult, catalog: AssemblyCatalogRow[], over: Partial<PartialCommitShadowDeps> = {}) {
  const fencedCalls: FencedCommitInput[] = [];
  const noWriteCalls: Record<string, number>[] = [];
  const logs: string[] = [];
  const deps: PartialCommitShadowDeps = {
    runReconciliation: async () => partial,
    loadCatalogRows: async () => catalog,
    fencedCommit: vi.fn(async (input: FencedCommitInput) => { fencedCalls.push(input); return { committed: true, finalizationMs: 42, writtenCount: input.priceWriteSkus.length }; }),
    markCompletedNoWrite: vi.fn(async (stats) => { noWriteCalls.push(stats); return true; }),
    onLog: async (_l, m) => { logs.push(m); },
    nowMs: () => 0,
    ...over,
  };
  return { deps, fencedCalls, noWriteCalls, logs };
}
const PRICE_SAMPLE_PREFIX = "[PartialCommitPriceSample] ";
const priceSampleLog = (logs: string[]) => logs.find((m) => m.startsWith(PRICE_SAMPLE_PREFIX));
const parseSample = (logs: string[]) => JSON.parse(priceSampleLog(logs)!.slice(PRICE_SAMPLE_PREFIX.length));

const sitemap = (fichas: string[]): Pick<SkuFirstPartialResult, "sitemapStartUrls" | "sitemapEndUrls" | "sitemapStartOk" | "sitemapEndOk"> =>
  ({ sitemapStartUrls: fichas, sitemapEndUrls: fichas, sitemapStartOk: true, sitemapEndOk: true });

describe("decidePartialCommit (puro)", () => {
  const ok = { abort: false, delistedRatio: 0, reasons: [] };
  const pf = (verdict: any) => ({ verdict } as any);
  it("health abort → no write, DIAGNOSTIC_ONLY", () => {
    const d = decidePartialCommit({ abort: true, delistedRatio: 0.2, reasons: ["x"] }, pf("PASS"));
    expect(d.authorizeWrite).toBe(false);
    expect(d.classification).toBe("GREEN_FAIL_CLOSED_ABNORMAL_FAILURE_RATE");
    expect(d.lifecyclePreviewStatus).toBe("DIAGNOSTIC_ONLY");
  });
  it("preflight ABORT → STOP_UNSAFE_PRICE_MAGNITUDE", () => {
    expect(decidePartialCommit(ok, pf("ABORT")).classification).toBe("STOP_UNSAFE_PRICE_MAGNITUDE");
  });
  it("preflight REVIEW_REQUIRED → no write", () => {
    const d = decidePartialCommit(ok, pf("REVIEW_REQUIRED"));
    expect(d.authorizeWrite).toBe(false);
    expect(d.classification).toBe("GREEN_WALK_PRICE_REVIEW_REQUIRED_NO_WRITE");
  });
  it("ambos PASS → write", () => {
    const d = decidePartialCommit(ok, pf("PASS"));
    expect(d.authorizeWrite).toBe(true);
    expect(d.classification).toBe("GREEN_FIRST_PRODUCTIVE_PRICE_WRITE");
    expect(d.lifecyclePreviewStatus).toBe("VALID_SHADOW_WITH_PRICE_WRITE");
  });
});

describe("runPartialCommitShadow", () => {
  it("W1) health PASS + preflight PASS → fenced write con SÓLO el write-set", async () => {
    const partial: SkuFirstPartialResult = {
      products: [{ sku: "A", productUrl: FA, wholesalePrice: 105, name: "A", description: null, oldPrice: null, stock: null, category: null, brand: null, imageUrl: null, rawData: {} }],
      fichaObservations: [{ ordinal: 0, url: FA, elapsedMs: 1, outcome: "VERIFIED_OK", variantsCaptured: 1, recoveredAfter429: false, recoveryAttempts: 0, httpStatusFinal: 200, variantSetComplete: true }],
      fichaQuarantine: {}, ...sitemap([canonA]),
      completenessComplete: true, completenessReasonCode: null, completenessDiagnostics: {},
    };
    const catalog: AssemblyCatalogRow[] = [{ sku: "A", productUrl: FA, wholesalePrice: 100 }];
    const { deps, fencedCalls, noWriteCalls } = makeDeps(partial, catalog);
    const r = await runPartialCommitShadow(deps);
    expect(r.classification).toBe("GREEN_FIRST_PRODUCTIVE_PRICE_WRITE");
    expect(r.fencedTransactionOpened).toBe(true);
    expect(noWriteCalls.length).toBe(0);
    expect(fencedCalls.length).toBe(1);
    expect(fencedCalls[0].priceWriteSkus).toEqual([{ sku: "A", newPrice: 105 }]);
    expect(r.priceWriteSetSize).toBe(1);
  });

  it("W10) SKUs nuevos del proveedor: existentes se escriben; nuevos sólo discovery (observación), no en price write", async () => {
    const partial: SkuFirstPartialResult = {
      products: [
        { sku: "A", productUrl: FA, wholesalePrice: 105, name: "A", description: null, oldPrice: null, stock: null, category: null, brand: null, imageUrl: null, rawData: {} },
        { sku: "NUEVO", productUrl: FA, wholesalePrice: 200, name: "N", description: null, oldPrice: null, stock: null, category: null, brand: null, imageUrl: null, rawData: {} },
      ],
      fichaObservations: [{ ordinal: 0, url: FA, elapsedMs: 1, outcome: "VERIFIED_OK", variantsCaptured: 2, recoveredAfter429: false, recoveryAttempts: 0, httpStatusFinal: 200, variantSetComplete: true }],
      fichaQuarantine: {}, ...sitemap([canonA]),
      completenessComplete: true, completenessReasonCode: null, completenessDiagnostics: {},
    };
    const catalog: AssemblyCatalogRow[] = [{ sku: "A", productUrl: FA, wholesalePrice: 100 }];
    const { deps, fencedCalls } = makeDeps(partial, catalog);
    const r = await runPartialCommitShadow(deps);
    expect(r.providerNewSkuCount).toBe(1);
    // el write-set NO incluye NUEVO; las observaciones (ExtractedProduct) SÍ (política OBSERVATIONS).
    expect(fencedCalls[0].priceWriteSkus).toEqual([{ sku: "A", newPrice: 105 }]);
    expect(fencedCalls[0].observations.map((o: { sku: string | null }) => o.sku).sort()).toEqual(["A", "NUEVO"]);
  });

  it("W4/W21) RATE_LIMITED>5 → health abort → sin fenced, lifecycle DIAGNOSTIC_ONLY calculado", async () => {
    const fichas = Array.from({ length: 6 }, (_, i) => `https://differenttouch.com.ar/productos/rl${i}`);
    const partial: SkuFirstPartialResult = {
      products: [],
      fichaObservations: fichas.map((u, i) => ({ ordinal: i, url: u, elapsedMs: 1, outcome: "RATE_LIMITED" as const, variantsCaptured: 0, recoveredAfter429: false, recoveryAttempts: 3, httpStatusFinal: 429, variantSetComplete: "unknown" as const })),
      fichaQuarantine: {}, ...sitemap(fichas.map((u) => u.replace("https://", ""))),
      completenessComplete: false, completenessReasonCode: "R2", completenessDiagnostics: {},
    };
    const catalog: AssemblyCatalogRow[] = fichas.map((u, i) => ({ sku: `RL${i}`, productUrl: u, wholesalePrice: 100 }));
    const { deps, fencedCalls, noWriteCalls } = makeDeps(partial, catalog);
    const r = await runPartialCommitShadow(deps);
    expect(r.classification).toBe("GREEN_FAIL_CLOSED_ABNORMAL_FAILURE_RATE");
    expect(fencedCalls.length).toBe(0); // NINGUNA transacción
    expect(noWriteCalls.length).toBe(1);
    expect(r.lifecyclePreviewStatus).toBe("DIAGNOSTIC_ONLY");
    expect(r.lifecycle.lifecycleShadowWrites).toBe(0); // calculado igual
  });

  it("W7/W22) mediana de cambio > 0.25 → REVIEW_REQUIRED → sin fenced, VALID_SHADOW_NO_PRICE_WRITE", async () => {
    const partial: SkuFirstPartialResult = {
      products: [{ sku: "A", productUrl: FA, wholesalePrice: 150, name: "A", description: null, oldPrice: null, stock: null, category: null, brand: null, imageUrl: null, rawData: {} }],
      fichaObservations: [{ ordinal: 0, url: FA, elapsedMs: 1, outcome: "VERIFIED_OK", variantsCaptured: 1, recoveredAfter429: false, recoveryAttempts: 0, httpStatusFinal: 200, variantSetComplete: true }],
      fichaQuarantine: {}, ...sitemap([canonA]),
      completenessComplete: true, completenessReasonCode: null, completenessDiagnostics: {},
    };
    const catalog: AssemblyCatalogRow[] = [{ sku: "A", productUrl: FA, wholesalePrice: 100 }]; // +50% → mediana 0.5
    const { deps, fencedCalls, noWriteCalls } = makeDeps(partial, catalog);
    const r = await runPartialCommitShadow(deps);
    expect(r.classification).toBe("GREEN_WALK_PRICE_REVIEW_REQUIRED_NO_WRITE");
    expect(fencedCalls.length).toBe(0);
    expect(noWriteCalls.length).toBe(1);
    expect(r.lifecyclePreviewStatus).toBe("VALID_SHADOW_NO_PRICE_WRITE");
  });

  it("W43) present-without-price anomaly=true PERO write-set válido → autoriza escritura igual (anomaly no cambia elegibilidad)", async () => {
    const FB = "https://differenttouch.com.ar/productos/b";
    const partial: SkuFirstPartialResult = {
      products: [{ sku: "A", productUrl: FA, wholesalePrice: 105, name: "A", description: null, oldPrice: null, stock: null, category: null, brand: null, imageUrl: null, rawData: {} }],
      fichaObservations: [
        { ordinal: 0, url: FA, elapsedMs: 1, outcome: "VERIFIED_OK", variantsCaptured: 1, recoveredAfter429: false, recoveryAttempts: 0, httpStatusFinal: 200, variantSetComplete: true },
        { ordinal: 1, url: FB, elapsedMs: 1, outcome: "VERIFIED_OK", variantsCaptured: 1, recoveredAfter429: false, recoveryAttempts: 0, httpStatusFinal: 200, variantSetComplete: true },
      ],
      fichaQuarantine: {}, ...sitemap([canonA, "differenttouch.com.ar/productos/b"]),
      completenessComplete: true, completenessReasonCode: null, completenessDiagnostics: {},
    };
    // A observado con precio; B observado SIN precio (present-without-price). ratio 1/2=0.5 > 0.15.
    (partial.products as any).push({ sku: "B", productUrl: FB, wholesalePrice: null, name: "B", description: null, oldPrice: null, stock: null, category: null, brand: null, imageUrl: null, rawData: {} });
    const catalog: AssemblyCatalogRow[] = [{ sku: "A", productUrl: FA, wholesalePrice: 100 }, { sku: "B", productUrl: FB, wholesalePrice: null }];
    const { deps, fencedCalls } = makeDeps(partial, catalog);
    const r = await runPartialCommitShadow(deps);
    expect(r.presentWithoutPriceCeiling.anomaly).toBe(true); // 1/2 > 0.15
    expect(r.classification).toBe("GREEN_FIRST_PRODUCTIVE_PRICE_WRITE"); // elegibilidad de escritura NO cambia
    expect(fencedCalls[0].priceWriteSkus).toEqual([{ sku: "A", newPrice: 105 }]); // sólo A escribe
  });

  // ── OBS1 · [PartialCommitPriceSample] (observabilidad; sobrevive REVIEW_REQUIRED) ──
  const onePartial = (observedPrice: number): SkuFirstPartialResult => ({
    products: [{ sku: "A", productUrl: FA, wholesalePrice: observedPrice, name: "A", description: null, oldPrice: null, stock: null, category: null, brand: null, imageUrl: null, rawData: {} }],
    fichaObservations: [{ ordinal: 0, url: FA, elapsedMs: 1, outcome: "VERIFIED_OK", variantsCaptured: 1, recoveredAfter429: false, recoveryAttempts: 0, httpStatusFinal: 200, variantSetComplete: true }],
    fichaQuarantine: {}, ...sitemap([canonA]),
    completenessComplete: true, completenessReasonCode: null, completenessDiagnostics: {},
  });
  const oneCatalog = (oldPrice: number): AssemblyCatalogRow[] => [{ sku: "A", productUrl: FA, wholesalePrice: oldPrice }];

  it("OBS1/OBS6) preflight PASS → sample emitido, parseable, schemaVersion=1, valores == preflight", async () => {
    const { deps, logs } = makeDeps(onePartial(105), oneCatalog(100));
    await runPartialCommitShadow(deps);
    const raw = priceSampleLog(logs);
    expect(raw).toBeDefined();
    expect(raw!.startsWith(PRICE_SAMPLE_PREFIX)).toBe(true);
    const s = parseSample(logs);
    expect(s.schemaVersion).toBe(1);
    expect(s.priceReviewApplicable).toBe(true);
    expect(s.priceReviewStatus).toBe("DECISION_RELEVANT");
    expect(s.pricePlausibilityVerdict).toBe("PASS");
    expect(s.priceWriteSetSize).toBe(1);
    expect(s.wholesalePriceChangedCount).toBe(1);
    expect(s.priceChangeSampleMax20.length).toBeLessThanOrEqual(20);
    expect(s.priceChangeSampleMax20[0]).toMatchObject({ sku: "A", old: 100, new: 105 });
    expect(s.priceChangeSampleMax20[0].rel).toBeCloseTo(0.05, 4);
  });

  it("OBS7) PWP evaluado UNA sola vez: el ratio del price sample == el del reporte canónico (misma fuente)", async () => {
    const { deps, logs } = makeDeps(onePartial(105), oneCatalog(100));
    const r = await runPartialCommitShadow(deps);
    const s = parseSample(logs);
    expect(s.presentWithoutPriceRatioCatalog).toBe(r.presentWithoutPriceCeiling.ratio); // mismo objeto canónico
  });

  it("OBS2) REVIEW_REQUIRED → fenced tx NO abre, markCompletedNoWrite, PERO sample SÍ emitido (load-bearing)", async () => {
    const { deps, logs, fencedCalls, noWriteCalls } = makeDeps(onePartial(150), oneCatalog(100)); // +50% → REVIEW
    const r = await runPartialCommitShadow(deps);
    expect(r.classification).toBe("GREEN_WALK_PRICE_REVIEW_REQUIRED_NO_WRITE");
    expect(fencedCalls.length).toBe(0);
    expect(noWriteCalls.length).toBe(1); // → ExtractedProduct = 0 (no createMany)
    const s = parseSample(logs);
    expect(s.priceReviewApplicable).toBe(true);
    expect(s.priceReviewStatus).toBe("DECISION_RELEVANT");
    expect(s.pricePlausibilityVerdict).toBe("REVIEW_REQUIRED");
    expect(s.priceChangeSampleMax20[0]).toMatchObject({ sku: "A", old: 100, new: 150 });
  });

  it("OBS3) preflight ABORT objetivo (order-of-magnitude) → writes=0, sample persistido", async () => {
    const { deps, logs, fencedCalls } = makeDeps(onePartial(500), oneCatalog(10)); // 50x
    const r = await runPartialCommitShadow(deps);
    expect(r.classification).toBe("STOP_UNSAFE_PRICE_MAGNITUDE");
    expect(fencedCalls.length).toBe(0);
    expect(parseSample(logs).priceOrderOfMagnitudeShiftCount).toBe(1);
  });

  it("OBS4) preflight PASS + fenced tx luego LANZA → el sample ya fue emitido (no depende del rollback)", async () => {
    const { deps, logs } = makeDeps(onePartial(105), oneCatalog(100), { fencedCommit: async () => { throw new Error("fenced boom"); } });
    await expect(runPartialCommitShadow(deps)).rejects.toThrow(/fenced boom/);
    expect(priceSampleLog(logs)).toBeDefined(); // emitido ANTES de la tx
    expect(parseSample(logs).priceReviewApplicable).toBe(true);
  });

  it("OBS5) health gate abort → evidencia PRESERVADA etiquetada DIAGNOSTIC_ONLY (métricas presentes, no aplica)", async () => {
    const fichas = Array.from({ length: 6 }, (_, i) => `https://differenttouch.com.ar/productos/rl${i}`);
    const partial: SkuFirstPartialResult = {
      products: [],
      fichaObservations: fichas.map((u, i) => ({ ordinal: i, url: u, elapsedMs: 1, outcome: "RATE_LIMITED" as const, variantsCaptured: 0, recoveredAfter429: false, recoveryAttempts: 3, httpStatusFinal: 429, variantSetComplete: "unknown" as const })),
      fichaQuarantine: {}, ...sitemap(fichas.map((u) => u.replace("https://", ""))),
      completenessComplete: false, completenessReasonCode: "R2", completenessDiagnostics: {},
    };
    const catalog: AssemblyCatalogRow[] = fichas.map((u, i) => ({ sku: `RL${i}`, productUrl: u, wholesalePrice: 100 }));
    const { deps, logs, fencedCalls } = makeDeps(partial, catalog);
    const r = await runPartialCommitShadow(deps);
    expect(r.classification).toBe("GREEN_FAIL_CLOSED_ABNORMAL_FAILURE_RATE");
    expect(fencedCalls.length).toBe(0); // health abort → NO escritura
    const s = parseSample(logs);
    expect(s.schemaVersion).toBe(1);
    // OBS1-R1: el preflight SÍ se computa aunque health aborte → evidencia PRESERVADA, no descartada.
    expect(s.priceReviewApplicable).toBe(false); // no es el verdict aplicado para autorizar escritura
    expect(s.priceReviewStatus).toBe("DIAGNOSTIC_ONLY");
    expect(s.reason).toBe("HEALTH_GATE_ABORT");
    // métricas reales presentes (NO fabricadas): el payload conserva la muestra computada.
    expect(s.pricePlausibilityVerdict).toBeDefined();
    expect(s.priceWriteSetSize).toBe(0);
    expect(Array.isArray(s.priceChangeSampleMax20)).toBe(true);
    expect(Array.isArray(s.top5Outliers)).toBe(true);
  });

  it("W32) fencedCommit NUNCA se llama si no se autoriza escritura (orden de fases)", async () => {
    // preflight ABORT (order-of-magnitude): A 10→500.
    const partial: SkuFirstPartialResult = {
      products: [{ sku: "A", productUrl: FA, wholesalePrice: 500, name: "A", description: null, oldPrice: null, stock: null, category: null, brand: null, imageUrl: null, rawData: {} }],
      fichaObservations: [{ ordinal: 0, url: FA, elapsedMs: 1, outcome: "VERIFIED_OK", variantsCaptured: 1, recoveredAfter429: false, recoveryAttempts: 0, httpStatusFinal: 200, variantSetComplete: true }],
      fichaQuarantine: {}, ...sitemap([canonA]),
      completenessComplete: true, completenessReasonCode: null, completenessDiagnostics: {},
    };
    const catalog: AssemblyCatalogRow[] = [{ sku: "A", productUrl: FA, wholesalePrice: 10 }];
    const { deps, fencedCalls } = makeDeps(partial, catalog);
    const r = await runPartialCommitShadow(deps);
    expect(r.classification).toBe("STOP_UNSAFE_PRICE_MAGNITUDE");
    expect(fencedCalls.length).toBe(0);
  });
});
