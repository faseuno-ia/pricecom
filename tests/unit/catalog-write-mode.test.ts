import { describe, it, expect } from "vitest";
import {
  resolveCatalogWriteMode,
  CatalogWriteModeError,
  resolvePriceOnlyBatch,
  PriceOnlyNewSkuError,
  PriceOnlyInvalidSkuError,
  PriceOnlyInvalidPriceError,
  isValidWholesalePrice,
  type PriceOnlyIncoming,
} from "../../lib/catalog/catalog-write-mode";

describe("resolveCatalogWriteMode", () => {
  it("null/undefined/blank -> FULL; FULL/PRICE_ONLY (trim) -> self", () => {
    for (const v of [null, undefined, "", "   ", "FULL", " FULL "]) expect(resolveCatalogWriteMode(v)).toBe("FULL");
    expect(resolveCatalogWriteMode("PRICE_ONLY")).toBe("PRICE_ONLY");
    expect(resolveCatalogWriteMode(" PRICE_ONLY ")).toBe("PRICE_ONLY");
  });
  it("garbage / wrong-case / non-string -> throws fail-loud", () => {
    expect(() => resolveCatalogWriteMode("XYZ")).toThrow(CatalogWriteModeError);
    expect(() => resolveCatalogWriteMode("price_only")).toThrow(CatalogWriteModeError);
    let caught: unknown;
    try { resolveCatalogWriteMode(5); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(CatalogWriteModeError);
    expect((caught as CatalogWriteModeError).rawValue).toBe("5");
  });
  it("error lleva field + rawValue, sin secretos", () => {
    let caught: unknown;
    try { resolveCatalogWriteMode("SUPER_SECRET_MODE"); } catch (e) { caught = e; }
    const err = caught as CatalogWriteModeError;
    expect(err.field).toBe("catalogWriteMode");
    expect(err.rawValue).toBe("SUPER_SECRET_MODE");
    expect(err.message).toContain("field=catalogWriteMode");
    expect(err.message).not.toMatch(/password|token|cookie|secret=/i);
  });
});

describe("isValidWholesalePrice", () => {
  it("número finito > 0; rechaza null/0/neg/NaN/Infinity/string", () => {
    expect(isValidWholesalePrice(1234)).toBe(true);
    for (const v of [null, undefined, 0, -5, NaN, Infinity, -Infinity, "10", {}]) expect(isValidWholesalePrice(v as any)).toBe(false);
  });
});

// ── R7.2-R1 · resolvePriceOnlyBatch (PHASE 1: validar TODO antes de cualquier write) ──
const existMap = (skus: string[]) => new Map(skus.map((s, i) => [s, { id: `cat-${i}` }]));
const inc = (sku: string | null, wp: number | null, id = "ep-x"): PriceOnlyIncoming => ({ sku, wholesalePrice: wp, extractedProductId: id });
const CATALOG = existMap(["S1", "S2", "S3"]);

describe("resolvePriceOnlyBatch · §8 SKU nuevo en cualquier posición → throw, CERO resolved", () => {
  it("A [NEW, exist, exist]", () => {
    expect(() => resolvePriceOnlyBatch([inc("NEW", 10), inc("S1", 10), inc("S2", 10)], CATALOG)).toThrow(PriceOnlyNewSkuError);
  });
  it("B [exist, NEW, exist]", () => {
    expect(() => resolvePriceOnlyBatch([inc("S1", 10), inc("NEW", 10), inc("S2", 10)], CATALOG)).toThrow(PriceOnlyNewSkuError);
  });
  it("C [exist, exist, NEW]", () => {
    expect(() => resolvePriceOnlyBatch([inc("S1", 10), inc("S2", 10), inc("NEW", 10)], CATALOG)).toThrow(PriceOnlyNewSkuError);
  });
});

describe("resolvePriceOnlyBatch · SKU inválido en cualquier posición → throw", () => {
  it("blank/null first/middle/last → PriceOnlyInvalidSkuError", () => {
    expect(() => resolvePriceOnlyBatch([inc(null, 10), inc("S1", 10)], CATALOG)).toThrow(PriceOnlyInvalidSkuError);
    expect(() => resolvePriceOnlyBatch([inc("S1", 10), inc("   ", 10), inc("S2", 10)], CATALOG)).toThrow(PriceOnlyInvalidSkuError);
    expect(() => resolvePriceOnlyBatch([inc("S1", 10), inc("S2", 10), inc(null, 10)], CATALOG)).toThrow(PriceOnlyInvalidSkuError);
  });
});

describe("resolvePriceOnlyBatch · §9 precio inválido en cualquier posición → throw (autosuficiente, sin D)", () => {
  for (const [label, bad] of [["null", null], ["0", 0], ["negativo", -5], ["NaN", NaN], ["Infinity", Infinity]] as [string, number | null][]) {
    it(`precio ${label} first → PriceOnlyInvalidPriceError`, () => {
      expect(() => resolvePriceOnlyBatch([inc("S1", bad), inc("S2", 10)], CATALOG)).toThrow(PriceOnlyInvalidPriceError);
    });
  }
  it("caso crítico [valid, valid, null-price] → PriceOnlyInvalidPriceError (cero resolved)", () => {
    let caught: unknown;
    try { resolvePriceOnlyBatch([inc("S1", 10), inc("S2", 20), inc("S3", null)], CATALOG); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(PriceOnlyInvalidPriceError);
    expect((caught as PriceOnlyInvalidPriceError).reasonCode).toBe("PRICE_ONLY_INVALID_PRICE");
  });
});

describe("resolvePriceOnlyBatch · §10 todos válidos → resuelve sólo campos price-only", () => {
  it("N updates con {catalogProductId, wholesalePrice, latestExtractedProductId}", () => {
    const out = resolvePriceOnlyBatch([inc("S1", 100, "ep1"), inc(" S2 ", 200, "ep2"), inc("S3", 300, "ep3")], CATALOG);
    expect(out).toEqual([
      { catalogProductId: "cat-0", wholesalePrice: 100, latestExtractedProductId: "ep1" },
      { catalogProductId: "cat-1", wholesalePrice: 200, latestExtractedProductId: "ep2" },
      { catalogProductId: "cat-2", wholesalePrice: 300, latestExtractedProductId: "ep3" },
    ]);
    // ningún campo comercial/lifecycle en el resolved
    for (const u of out) expect(Object.keys(u).sort()).toEqual(["catalogProductId", "latestExtractedProductId", "wholesalePrice"]);
  });
  it("lista vacía → [] (sin updates)", () => {
    expect(resolvePriceOnlyBatch([], CATALOG)).toEqual([]);
  });
});
