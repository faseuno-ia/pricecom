// 2G-R5D — tests del guard pre-write de regresión de precios. Puros (sin DB) + estructural del
// write barrier del worker (el guard corre ANTES de la primera escritura comercial).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  analyzePreWritePriceRegression,
  assertNoPreWritePriceRegression,
  assertNoPreWritePriceRegressionForExtraction,
  isValidWholesalePrice,
  PreWritePriceGuardError,
  PreWriteGuardTenantError,
  NULL_PROPAGATION_TO_OWN_CHILDREN_POSSIBLE,
  type ExistingCatalogRow,
  type OwnChildRow,
  type IncomingProductRow,
  type PreWriteCatalogReader,
} from "@/lib/catalog/pre-write-price-guard";
import {
  finalizeSuccessfulExtraction,
  resolveEffectiveUserId,
  handleJobFailure,
  type FinalizeExtractionDeps,
  type JobFailureDeps,
} from "../../worker/src/finalize-extraction";
import { vi } from "vitest";

const ex = (id: string, sku: string, wp: number | null): ExistingCatalogRow => ({ id, sku, wholesalePrice: wp });
const child = (id: string, parentId: string, wp: number | null): OwnChildRow => ({ id, sourceCatalogProductId: parentId, wholesalePrice: wp });
const inc = (sku: string | null, wp: number | null): IncomingProductRow => ({ sku, wholesalePrice: wp });
const analyze = (existing: ExistingCatalogRow[], ownChildren: OwnChildRow[], incoming: IncomingProductRow[]) =>
  analyzePreWritePriceRegression({ existing, ownChildren, incoming });
const CTX = { providerId: "prov1", jobId: "job1" };
const asserts = (a: ReturnType<typeof analyze>, requiresLogin: boolean) => () => assertNoPreWritePriceRegression(a, requiresLogin, CTX);

describe("2G-R5D · isValidWholesalePrice (semántica compartida: número finito > 0)", () => {
  it("acepta > 0 finito; rechaza null/undefined/0/negativo/NaN/string", () => {
    expect(isValidWholesalePrice(100)).toBe(true);
    for (const v of [null, undefined, 0, -5, NaN, Infinity, "100", {}]) expect(isValidWholesalePrice(v as any)).toBe(false);
  });
});

describe("2G-R5D · analyzePreWritePriceRegression (casos §8)", () => {
  it("1 · existing 100 + incoming 120 → PASS (sin priced→null)", () => {
    const a = analyze([ex("a", "S1", 100)], [], [inc("S1", 120)]);
    expect(a.pricedToNullCount).toBe(0);
    expect(asserts(a, false)).not.toThrow();
  });
  it("2 · existing 100 + incoming null → FAIL direct priced→null=1", () => {
    const a = analyze([ex("a", "S1", 100)], [], [inc("S1", null)]);
    expect(a.directPricedToNullCount).toBe(1);
    expect(a.pricedToNullCount).toBe(1);
    expect(a.pricedToNullSkuSample).toEqual(["S1"]);
    expect(asserts(a, false)).toThrow(PreWritePriceGuardError);
    try { asserts(a, false)(); } catch (e: any) { expect(e.code).toBe("PRE_WRITE_PRICE_REGRESSION_DETECTED"); expect(e.message).not.toMatch(/100|120/); }
  });
  it("3 · existing null + incoming null → PASS (no es transición priced→null)", () => {
    const a = analyze([ex("a", "S1", null)], [], [inc("S1", null)]);
    expect(a.pricedToNullCount).toBe(0);
    expect(asserts(a, false)).not.toThrow();
  });
  it("4 · SKU nuevo + incoming null → no priced→null; newNullSku=1", () => {
    const a = analyze([], [], [inc("NEW", null)]);
    expect(a.pricedToNullCount).toBe(0);
    expect(a.newSkuWithNullPriceCount).toBe(1);
    expect(asserts(a, false)).not.toThrow();
  });
  it("5 · requiresLogin + todos incoming null → FAIL LOGIN_GATED_EXTRACTION_HAS_ZERO_VALID_PRICES", () => {
    const a = analyze([], [], [inc("N1", null), inc("N2", null)]);
    expect(a.incomingValidPriceCount).toBe(0);
    try { assertNoPreWritePriceRegression(a, true, CTX); throw new Error("no lanzó"); }
    catch (e: any) { expect(e.code).toBe("LOGIN_GATED_EXTRACTION_HAS_ZERO_VALID_PRICES"); }
  });
  it("6 · requiresLogin=false + todos null + sin transición → NO falla por regla login-gated", () => {
    const a = analyze([], [], [inc("N1", null)]);
    expect(asserts(a, false)).not.toThrow();
  });
  it("7 · un válido + varios null, sin existing priced afectado → no falla por zero-valid; reporta nulls", () => {
    const a = analyze([], [], [inc("V", 50), inc("N1", null), inc("N2", null)]);
    expect(a.incomingValidPriceCount).toBe(1);
    expect(a.newSkuWithNullPriceCount).toBe(2);
    expect(asserts(a, true)).not.toThrow(); // hay ≥1 precio válido
  });
  it("8 · SKU con whitespace se normaliza; sin doble conteo", () => {
    const a = analyze([ex("a", "S1", 100)], [], [inc(" S1 ", null)]);
    expect(a.directPricedToNullCount).toBe(1); // "S1" trim matchea
  });
  it("9 · existing parent 100 + incoming parent null → FAIL directo", () => {
    const a = analyze([ex("p", "P", 100)], [], [inc("P", null)]);
    expect(a.pricedToNullCount).toBe(1);
    expect(asserts(a, false)).toThrow();
  });
  it("10 · existing parent null + OWN child 100 + incoming parent null → propagación SALTEADA (código real) ⇒ child preservado ⇒ PASS", () => {
    // NOTA: el upsert real (upsert-catalog-products.ts:378) sólo propaga cuando incoming != null.
    // Con incoming null, la propagación se saltea y el hijo se PRESERVA. La expectativa "FAIL propagado"
    // del prompt NO coincide con el código vigente; el guard modela fielmente el comportamiento real.
    const a = analyze([ex("p", "P", null)], [child("c", "p", 100)], [inc("P", null)]);
    expect(a.propagatedOwnChildPricedToNullCount).toBe(0);
    expect(a.pricedToNullCount).toBe(0);
    expect(asserts(a, false)).not.toThrow();
  });
  it("11 · parent y child priced, incoming parent null → total dedup = 1 (sólo el parent directo; child preservado)", () => {
    const a = analyze([ex("p", "P", 100)], [child("c", "p", 100)], [inc("P", null)]);
    expect(a.directPricedToNullCount).toBe(1);
    expect(a.propagatedOwnChildPricedToNullCount).toBe(0);
    expect(a.pricedToNullCount).toBe(1);
  });
  it("12/13 · SKU inexistente → create path, sin transición", () => {
    const a = analyze([ex("a", "S1", 100)], [], [inc("OTHER", 30)]);
    expect(a.pricedToNullCount).toBe(0);
    expect(a.newSkuWithValidPriceCount).toBe(1);
  });
  it("14 · incoming NaN/inválido con existing válido → priced→null (misma semántica que precio inválido)", () => {
    const a = analyze([ex("a", "S1", 100)], [], [inc("S1", NaN as any)]);
    expect(a.pricedToNullCount).toBe(1);
  });
  it("15 · requiresLogin + incomingRows=0 → NO dispara regla login-gated (completitud lo maneja aparte)", () => {
    const a = analyze([ex("a", "S1", 100)], [], []);
    expect(a.incomingRowCount).toBe(0);
    expect(asserts(a, true)).not.toThrow();
  });
  it("propagación con incoming VÁLIDO cuenta hijos afectados pero jamás produce null", () => {
    const a = analyze([ex("p", "P", 100)], [child("c1", "p", 5), child("c2", "p", 5)], [inc("P", 120)]);
    expect(a.ownChildRowsPotentiallyAffected).toBe(2);
    expect(a.pricedToNullCount).toBe(0);
    expect(asserts(a, true)).not.toThrow();
  });
});

// §5 (R2) — la propagación null a hijos OWN es imposible (freeze): el analizador la modela en 0.
describe("2G-R5D-R2 · §5 propagación null a hijos OWN imposible (freeze)", () => {
  it("parent null + child OWN priced + incoming parent null → propagatedPricedToNull=0 (upsert no propaga null)", () => {
    const a = analyze([ex("p", "P", null)], [child("c", "p", 100)], [inc("P", null)]);
    expect(a.propagatedOwnChildPricedToNullCount).toBe(0);
    expect(a.pricedToNullCount).toBe(0);
  });
  it("NULL_PROPAGATION_TO_OWN_CHILDREN_POSSIBLE está congelado en false", () => {
    expect(NULL_PROPAGATION_TO_OWN_CHILDREN_POSSIBLE).toBe(false);
  });
});

// §1 — resolución de tenant FAIL-CLOSED.
describe("2G-R5D-R2 · §1 resolveEffectiveUserId (fail-closed)", () => {
  const CTX = { providerId: "prov1", jobId: "job1" };
  it("job.userId presente → lo usa", () => {
    expect(resolveEffectiveUserId({ userId: "u1" }, { userId: "u1" }, CTX)).toBe("u1");
  });
  it("job.userId ausente + provider.userId presente → fallback a provider.userId", () => {
    expect(resolveEffectiveUserId({ userId: null }, { userId: "u9" }, CTX)).toBe("u9");
  });
  it("ambos ausentes → lanza PRE_WRITE_PRICE_GUARD_USER_ID_MISSING", () => {
    try { resolveEffectiveUserId({ userId: null }, { userId: null }, CTX); throw new Error("no lanzó"); }
    catch (e: any) { expect(e).toBeInstanceOf(PreWriteGuardTenantError); expect(e.code).toBe("PRE_WRITE_PRICE_GUARD_USER_ID_MISSING"); }
  });
  it("job.userId ≠ provider.userId → lanza EXTRACTION_JOB_PROVIDER_USER_MISMATCH", () => {
    try { resolveEffectiveUserId({ userId: "u1" }, { userId: "u2" }, CTX); throw new Error("no lanzó"); }
    catch (e: any) { expect(e.code).toBe("EXTRACTION_JOB_PROVIDER_USER_MISMATCH"); }
  });
});

// §2/§3 — pipeline REAL de orquestación (finalizeSuccessfulExtraction) con deps inyectables.
const spOf = (sku: string | null, wp: number | null) =>
  ({ sku, name: "n", description: null, wholesalePrice: wp, oldPrice: null, stock: null, category: null, brand: null, productUrl: null, imageUrl: null, rawData: {} }) as any;
function mockFinalizeDeps(existing: ExistingCatalogRow[] = []) {
  const calls = { createMany: 0, upsert: 0, providerUpdate: 0, markCompleted: 0, comparison: 0, excel: 0, logCompleted: 0 };
  const deps: FinalizeExtractionDeps = {
    findExistingCatalog: vi.fn(async () => existing),
    createExtractedProducts: vi.fn(async () => { calls.createMany++; }),
    upsertCatalog: vi.fn(async () => { calls.upsert++; }),
    generateAndAttachExcel: vi.fn(async () => { calls.excel++; return { fileUrl: null, name: null, data: null }; }),
    updateProviderLastExtraction: vi.fn(async () => { calls.providerUpdate++; }),
    markCompleted: vi.fn(async () => { calls.markCompleted++; }),
    runComparison: vi.fn(async () => { calls.comparison++; return null; }),
    logCompleted: vi.fn(async () => { calls.logCompleted++; }),
    onLog: vi.fn(async () => {}),
  };
  return { deps, calls };
}
const prov = (over: Record<string, unknown> = {}) => ({ id: "prov1", requiresLogin: false, userId: "u1", ...over });
const jobOf = (over: Record<string, unknown> = {}) => ({ userId: "u1", ...over });
const noCommercialWrites = (c: ReturnType<typeof mockFinalizeDeps>["calls"]) =>
  c.createMany === 0 && c.upsert === 0 && c.providerUpdate === 0 && c.markCompleted === 0 && c.comparison === 0;

describe("2G-R5D-R2 · §3 pipeline: guard/tenant fallan cerrado ⇒ CERO escrituras comerciales", () => {
  it("A · priced→null → lanza y no ejecuta ninguna operación comercial", async () => {
    const { deps, calls } = mockFinalizeDeps([ex("a", "S1", 100)]);
    await expect(finalizeSuccessfulExtraction(deps, { products: [spOf("S1", null)], job: jobOf(), provider: prov(), jobId: "j1" }))
      .rejects.toBeInstanceOf(PreWritePriceGuardError);
    expect(noCommercialWrites(calls)).toBe(true);
  });
  it("B · login-gated sin precios → lanza y cero escrituras comerciales", async () => {
    const { deps, calls } = mockFinalizeDeps([]);
    await expect(finalizeSuccessfulExtraction(deps, { products: [spOf("N1", null)], job: jobOf(), provider: prov({ requiresLogin: true }), jobId: "j1" }))
      .rejects.toBeInstanceOf(PreWritePriceGuardError);
    expect(noCommercialWrites(calls)).toBe(true);
  });
  it("C · userId ausente → lanza USER_ID_MISSING antes de leer catálogo o escribir", async () => {
    const { deps, calls } = mockFinalizeDeps([]);
    await expect(finalizeSuccessfulExtraction(deps, { products: [spOf("S1", 50)], job: jobOf({ userId: null }), provider: prov({ userId: null }), jobId: "j1" }))
      .rejects.toBeInstanceOf(PreWriteGuardTenantError);
    expect(noCommercialWrites(calls)).toBe(true);
    expect(deps.findExistingCatalog).not.toHaveBeenCalled();
  });
  it("D · userId inconsistente → lanza MISMATCH y cero escrituras", async () => {
    const { deps, calls } = mockFinalizeDeps([]);
    await expect(finalizeSuccessfulExtraction(deps, { products: [spOf("S1", 50)], job: jobOf({ userId: "u1" }), provider: prov({ userId: "u2" }), jobId: "j1" }))
      .rejects.toBeInstanceOf(PreWriteGuardTenantError);
    expect(noCommercialWrites(calls)).toBe(true);
  });
  it("E · PASS → cada operación comercial se ejecuta exactamente una vez", async () => {
    const { deps, calls } = mockFinalizeDeps([ex("a", "S1", 100)]);
    await finalizeSuccessfulExtraction(deps, { products: [spOf("S1", 120)], job: jobOf(), provider: prov(), jobId: "j1" });
    expect(calls).toEqual({ createMany: 1, upsert: 1, providerUpdate: 1, markCompleted: 1, comparison: 1, excel: 1, logCompleted: 1 });
  });
});

// §4 — handler exterior: markFailed exactamente una vez, no continúa el flujo.
describe("2G-R5D-R2 · §4 handleJobFailure", () => {
  function mockFailureDeps() {
    const c = { markFailed: 0, logError: 0 };
    const deps: JobFailureDeps = {
      onLog: vi.fn(async () => {}),
      selectFailureMessage: (e: any) => (e instanceof Error ? e.message : String(e)),
      markFailed: vi.fn(async () => { c.markFailed++; }),
      sanitizeCompleteness: () => undefined,
      logError: vi.fn(async () => { c.logError++; }),
    };
    return { deps, c };
  }
  it("markFailed 1× + logError 1× ante un error del guard", async () => {
    const { deps, c } = mockFailureDeps();
    await handleJobFailure(deps, { jobId: "j1" }, new PreWritePriceGuardError("PRE_WRITE_PRICE_REGRESSION_DETECTED", analyze([ex("a", "S1", 100)], [], [inc("S1", null)]), { providerId: "p", jobId: "j1" }));
    expect(c.markFailed).toBe(1);
    expect(c.logError).toBe(1);
  });
  it("compuesto: finalize lanza (guard) → catch → handleJobFailure markFailed 1×, cero escrituras comerciales", async () => {
    const { deps: fdeps, calls } = mockFinalizeDeps([ex("a", "S1", 100)]);
    const { deps: jf, c } = mockFailureDeps();
    try { await finalizeSuccessfulExtraction(fdeps, { products: [spOf("S1", null)], job: jobOf(), provider: prov(), jobId: "j1" }); }
    catch (e) { await handleJobFailure(jf, { jobId: "j1" }, e); }
    expect(noCommercialWrites(calls)).toBe(true);
    expect(c.markFailed).toBe(1);
  });
});

describe("2G-R5D-R2 · orden en la unidad extraída (estructural, CI-safe)", () => {
  const src = readFileSync(resolve(process.cwd(), "worker/src/finalize-extraction.ts"), "utf8");
  const workerSrc = readFileSync(resolve(process.cwd(), "worker/src/index.ts"), "utf8");
  it("resolveEffectiveUserId y el guard corren ANTES de createExtractedProducts en la unidad", () => {
    const userIdIdx = src.indexOf("resolveEffectiveUserId(");
    const guardIdx = src.indexOf("assertNoPreWritePriceRegressionForExtraction(");
    const createIdx = src.indexOf("deps.createExtractedProducts(");
    expect(userIdIdx).toBeGreaterThan(-1);
    expect(userIdIdx).toBeLessThan(guardIdx);
    expect(guardIdx).toBeLessThan(createIdx);
  });
  it("el worker delega en finalizeSuccessfulExtraction y no tiene la bifurcación `&& job.userId`", () => {
    expect(workerSrc.indexOf("finalizeSuccessfulExtraction(")).toBeGreaterThan(-1);
    expect(workerSrc).not.toMatch(/products\.length > 0 && job\.userId/);
  });
});
