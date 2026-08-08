// 2G-R5D — tests del guard pre-write de regresión de precios. Puros (sin DB) + wired del
// entrypoint del worker (tenant fail-closed + análisis) + estructural del write barrier inline.
//
// R3: revertido el refactor del finalizador (finalize-extraction.ts eliminado). El guard vuelve a
// ser una barrera INLINE única en worker/src/index.ts, inmediatamente antes de createMany. No hay
// "pipeline behavioral test" porque no se reorganiza el success path productivo; la evidencia del
// write barrier son: (1) tests puros del analizador, (2) tests de rechazo tipado del entrypoint
// (tenant + precio), (3) test estructural del orden en worker/src/index.ts, (4) el catch histórico
// intacto.
import { describe, it, expect, vi } from "vitest";
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

// §5 — la propagación null a hijos OWN es imposible (freeze): el analizador la modela en 0.
describe("2G-R5D · §5 propagación null a hijos OWN imposible (freeze)", () => {
  it("parent null + child OWN priced + incoming parent null → propagatedPricedToNull=0 (upsert no propaga null)", () => {
    const a = analyze([ex("p", "P", null)], [child("c", "p", 100)], [inc("P", null)]);
    expect(a.propagatedOwnChildPricedToNullCount).toBe(0);
    expect(a.pricedToNullCount).toBe(0);
  });
  it("NULL_PROPAGATION_TO_OWN_CHILDREN_POSSIBLE está congelado en false", () => {
    expect(NULL_PROPAGATION_TO_OWN_CHILDREN_POSSIBLE).toBe(false);
  });
});

// §2 — TENANT fail-closed en el entrypoint único (job.userId es autoridad; provider.userId testigo).
function mockReader(existing: ExistingCatalogRow[] = []) {
  const findExisting = vi.fn(async (_u: string, _p: string, _s: string[]) => existing);
  return { reader: { findExisting } as PreWriteCatalogReader, findExisting };
}
const baseArgs = (over: Record<string, unknown> = {}) => ({
  userId: "u1" as string | null | undefined,
  providerUserId: "u1" as string | null | undefined,
  providerId: "prov1",
  requiresLogin: false,
  jobId: "job1",
  products: [inc("S1", 120)],
  ...over,
});

describe("2G-R5D-R3 · §2 tenant fail-closed en assertNoPreWritePriceRegressionForExtraction", () => {
  it("job.userId ausente (null) → lanza USER_ID_MISSING; NO lee catálogo", async () => {
    const { reader, findExisting } = mockReader([ex("a", "S1", 100)]);
    await expect(assertNoPreWritePriceRegressionForExtraction(reader, baseArgs({ userId: null })))
      .rejects.toBeInstanceOf(PreWriteGuardTenantError);
    expect(findExisting).not.toHaveBeenCalled();
  });
  it("job.userId blank ('   ') → lanza USER_ID_MISSING (fail-closed en blank)", async () => {
    const { reader, findExisting } = mockReader();
    try { await assertNoPreWritePriceRegressionForExtraction(reader, baseArgs({ userId: "   " })); throw new Error("no lanzó"); }
    catch (e: any) { expect(e).toBeInstanceOf(PreWriteGuardTenantError); expect(e.code).toBe("PRE_WRITE_PRICE_GUARD_USER_ID_MISSING"); }
    expect(findExisting).not.toHaveBeenCalled();
  });
  it("provider.userId ≠ job.userId → lanza MISMATCH; NO lee catálogo", async () => {
    const { reader, findExisting } = mockReader([ex("a", "S1", 100)]);
    try { await assertNoPreWritePriceRegressionForExtraction(reader, baseArgs({ userId: "u1", providerUserId: "u2" })); throw new Error("no lanzó"); }
    catch (e: any) { expect(e.code).toBe("EXTRACTION_JOB_PROVIDER_USER_MISMATCH"); }
    expect(findExisting).not.toHaveBeenCalled();
  });
  it("job.userId presente → el catálogo se lee con job.userId (provider NO lo reemplaza)", async () => {
    const { reader, findExisting } = mockReader([ex("a", "S1", 100)]);
    await assertNoPreWritePriceRegressionForExtraction(reader, baseArgs({ userId: "u1", providerUserId: "u1" }));
    expect(findExisting).toHaveBeenCalledTimes(1);
    expect(findExisting.mock.calls[0][0]).toBe("u1"); // primer arg = userId
  });
  it("provider.userId ausente + job.userId presente → usa job.userId (sin fallback a provider)", async () => {
    const { reader, findExisting } = mockReader([]);
    await assertNoPreWritePriceRegressionForExtraction(reader, baseArgs({ userId: "u7", providerUserId: null }));
    expect(findExisting).toHaveBeenCalledTimes(1);
    expect(findExisting.mock.calls[0][0]).toBe("u7");
  });
});

// §3/§5 — el entrypoint único analiza y ASERTA (priced→null / login-gated) tras resolver tenant.
describe("2G-R5D-R3 · assertNoPreWritePriceRegressionForExtraction (wired, tenant OK)", () => {
  it("priced→null (existing 100, incoming null) → rechaza PreWritePriceGuardError PRICE_REGRESSION", async () => {
    const { reader } = mockReader([ex("a", "S1", 100)]);
    try { await assertNoPreWritePriceRegressionForExtraction(reader, baseArgs({ products: [inc("S1", null)] })); throw new Error("no lanzó"); }
    catch (e: any) { expect(e).toBeInstanceOf(PreWritePriceGuardError); expect(e.code).toBe("PRE_WRITE_PRICE_REGRESSION_DETECTED"); }
  });
  it("login-gated (requiresLogin, incoming todos null, sin existing) → rechaza LOGIN_GATED", async () => {
    const { reader } = mockReader([]);
    try { await assertNoPreWritePriceRegressionForExtraction(reader, baseArgs({ requiresLogin: true, products: [inc("N1", null)] })); throw new Error("no lanzó"); }
    catch (e: any) { expect(e.code).toBe("LOGIN_GATED_EXTRACTION_HAS_ZERO_VALID_PRICES"); }
  });
  it("PASS (existing 100, incoming 120) → resuelve, devuelve análisis con pricedToNull=0", async () => {
    const { reader } = mockReader([ex("a", "S1", 100)]);
    const analysis = await assertNoPreWritePriceRegressionForExtraction(reader, baseArgs({ products: [inc("S1", 120)] }));
    expect(analysis.pricedToNullCount).toBe(0);
    expect(analysis.incomingValidPriceCount).toBe(1);
  });
  it("SKU nuevo con null + sin login → PASS (no es regresión)", async () => {
    const { reader } = mockReader([]);
    const analysis = await assertNoPreWritePriceRegressionForExtraction(reader, baseArgs({ requiresLogin: false, products: [inc("NEW", null)] }));
    expect(analysis.newSkuWithNullPriceCount).toBe(1);
    expect(analysis.pricedToNullCount).toBe(0);
  });
});

// §5 (R3) — estructural del write barrier INLINE en worker/src/index.ts (CI-safe: lee un tracked file).
describe("2G-R5D-R3 · write barrier inline en worker/src/index.ts (estructural)", () => {
  const workerSrc = readFileSync(resolve(process.cwd(), "worker/src/index.ts"), "utf8");
  // 2G-R8-Q1: dos paths de finalización (PRICE_ONLY fenced en tx + FULL inline), cada uno con SU
  // guard antes de SU createMany. El invariante deja de ser "exactamente 1" y pasa a ser "cada
  // createMany va precedido por un guard" (ningún createMany sin guard previo).
  it("cada createMany va precedido por una llamada al guard (guard antes de toda escritura comercial)", () => {
    const guards = [...workerSrc.matchAll(/assertNoPreWritePriceRegressionForExtraction\(/g)].map((m) => m.index!);
    const creates = [...workerSrc.matchAll(/extractedProduct\.createMany\(/g)].map((m) => m.index!);
    expect(guards.length).toBeGreaterThanOrEqual(1);
    expect(creates.length).toBeGreaterThanOrEqual(1);
    // por cada createMany existe un guard con índice menor y sin otro createMany entre medio
    for (const c of creates) {
      const guardsBefore = guards.filter((g) => g < c);
      expect(guardsBefore.length).toBeGreaterThan(0);
      const nearestGuard = Math.max(...guardsBefore);
      const createsBetween = creates.filter((c2) => c2 > nearestGuard && c2 < c);
      expect(createsBetween.length).toBe(0);
    }
  });
  it("el guard usa job.userId como autoridad y provider.userId sólo como testigo", () => {
    expect(workerSrc).toMatch(/userId:\s*job\.userId/);
    expect(workerSrc).toMatch(/providerUserId:\s*provider\.userId/);
  });
  it("NO existe el finalizador extraído ni la bifurcación permisiva `&& job.userId`", () => {
    expect(workerSrc).not.toMatch(/finalizeSuccessfulExtraction/);
    expect(workerSrc).not.toMatch(/products\.length > 0 && job\.userId/);
  });
  it("el catch histórico del job sigue intacto (selectFailureMessage + queue.markFailed)", () => {
    expect(workerSrc).toMatch(/selectFailureMessage\(err\)/);
    expect(workerSrc).toMatch(/queue\.markFailed\(/);
  });
});
