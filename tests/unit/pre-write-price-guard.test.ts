// 2G-R5D — tests del guard pre-write de regresión de precios. Puros (sin DB) + estructural del
// write barrier del worker (el guard corre ANTES de la primera escritura comercial).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  analyzePreWritePriceRegression,
  assertNoPreWritePriceRegression,
  isValidWholesalePrice,
  PreWritePriceGuardError,
  type ExistingCatalogRow,
  type OwnChildRow,
  type IncomingProductRow,
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

describe("2G-R5D · write barrier del worker (estructural, CI-safe)", () => {
  const src = readFileSync(resolve(process.cwd(), "worker/src/index.ts"), "utf8");
  it("el guard corre ANTES de extractedProduct.createMany", () => {
    const guardIdx = src.indexOf("assertNoPreWritePriceRegression(");
    const createManyIdx = src.indexOf("prisma.extractedProduct.createMany");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(createManyIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(createManyIdx);
  });
  it("el guard corre ANTES de la llamada a upsertCatalogProducts(...)", () => {
    const guardIdx = src.indexOf("assertNoPreWritePriceRegression(");
    // Última ocurrencia de la LLAMADA al upsert (no el import) debe estar después del guard.
    const upsertCallIdx = src.lastIndexOf("await upsertCatalogProducts(");
    expect(upsertCallIdx).toBeGreaterThan(-1);
    expect(guardIdx).toBeLessThan(upsertCallIdx);
  });
});
