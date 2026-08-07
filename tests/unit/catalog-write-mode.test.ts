import { describe, it, expect } from "vitest";
import {
  resolveCatalogWriteMode,
  CatalogWriteModeError,
  resolvePriceOnlyUpdate,
  PriceOnlyNewSkuError,
} from "../../lib/catalog/catalog-write-mode";

describe("resolveCatalogWriteMode", () => {
  it("null -> FULL", () => {
    expect(resolveCatalogWriteMode(null)).toBe("FULL");
  });
  it("undefined -> FULL", () => {
    expect(resolveCatalogWriteMode(undefined)).toBe("FULL");
  });
  it('"" -> FULL', () => {
    expect(resolveCatalogWriteMode("")).toBe("FULL");
  });
  it('"   " (whitespace-only) -> FULL', () => {
    expect(resolveCatalogWriteMode("   ")).toBe("FULL");
  });
  it('"FULL" -> FULL', () => {
    expect(resolveCatalogWriteMode("FULL")).toBe("FULL");
  });
  it('" FULL " (trim) -> FULL', () => {
    expect(resolveCatalogWriteMode(" FULL ")).toBe("FULL");
  });
  it('"PRICE_ONLY" -> PRICE_ONLY', () => {
    expect(resolveCatalogWriteMode("PRICE_ONLY")).toBe("PRICE_ONLY");
  });
  it('" PRICE_ONLY " (trim) -> PRICE_ONLY', () => {
    expect(resolveCatalogWriteMode(" PRICE_ONLY ")).toBe("PRICE_ONLY");
  });

  it('garbage "XYZ" -> throws CatalogWriteModeError', () => {
    expect(() => resolveCatalogWriteMode("XYZ")).toThrow(CatalogWriteModeError);
  });

  it('"price_only" (wrong case) -> throws', () => {
    expect(() => resolveCatalogWriteMode("price_only")).toThrow(
      CatalogWriteModeError
    );
  });

  it("number 5 (non-string non-null) -> throws CatalogWriteModeError with String(raw)", () => {
    let caught: unknown;
    try {
      resolveCatalogWriteMode(5);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CatalogWriteModeError);
    const err = caught as CatalogWriteModeError;
    expect(err.field).toBe("catalogWriteMode");
    expect(err.rawValue).toBe("5");
  });

  it("error carries field and rawValue, message contains no secrets", () => {
    let caught: unknown;
    try {
      resolveCatalogWriteMode("SUPER_SECRET_MODE");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CatalogWriteModeError);
    const err = caught as CatalogWriteModeError;
    expect(err.field).toBe("catalogWriteMode");
    expect(err.rawValue).toBe("SUPER_SECRET_MODE");
    // The message only echoes the field name, the (non-secret) invalid raw value, and the valid list.
    expect(err.message).toContain("field=catalogWriteMode");
    expect(err.message).toContain("valid: FULL, PRICE_ONLY");
    expect(err.message).not.toMatch(/password|token|cookie|secret=/i);
  });
});

describe("resolvePriceOnlyUpdate", () => {
  it("existing + valid price -> { catalogProductId, wholesalePrice:number }", () => {
    const result = resolvePriceOnlyUpdate(
      { id: "cat-1" },
      { sku: "ABC", wholesalePrice: 1234 }
    );
    expect(result).toEqual({ catalogProductId: "cat-1", wholesalePrice: 1234 });
    expect(typeof result.wholesalePrice).toBe("number");
  });

  it("existing + null price -> wholesalePrice null", () => {
    const result = resolvePriceOnlyUpdate(
      { id: "cat-2" },
      { sku: "ABC", wholesalePrice: null }
    );
    expect(result).toEqual({ catalogProductId: "cat-2", wholesalePrice: null });
  });

  it("existing + string-ish price coerced via Number", () => {
    const result = resolvePriceOnlyUpdate(
      { id: "cat-3" },
      { sku: "ABC", wholesalePrice: "6800" as unknown as number }
    );
    expect(result).toEqual({ catalogProductId: "cat-3", wholesalePrice: 6800 });
    expect(typeof result.wholesalePrice).toBe("number");
  });

  it("incoming.sku null -> throws PriceOnlyNewSkuError", () => {
    expect(() =>
      resolvePriceOnlyUpdate({ id: "cat-4" }, { sku: null, wholesalePrice: 1 })
    ).toThrow(PriceOnlyNewSkuError);
  });

  it('incoming.sku "   " (blank) -> throws PriceOnlyNewSkuError', () => {
    expect(() =>
      resolvePriceOnlyUpdate({ id: "cat-5" }, { sku: "   ", wholesalePrice: 1 })
    ).toThrow(PriceOnlyNewSkuError);
  });

  it("existing === null (SKU not in catalog) -> throws PriceOnlyNewSkuError", () => {
    expect(() =>
      resolvePriceOnlyUpdate(null, { sku: "ABC", wholesalePrice: 1 })
    ).toThrow(PriceOnlyNewSkuError);
  });

  it("thrown error carries reasonCode PRICE_ONLY_NEW_SKU_NOT_ALLOWED", () => {
    let caught: unknown;
    try {
      resolvePriceOnlyUpdate(null, { sku: "ABC", wholesalePrice: 1 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(PriceOnlyNewSkuError);
    expect((caught as PriceOnlyNewSkuError).reasonCode).toBe(
      "PRICE_ONLY_NEW_SKU_NOT_ALLOWED"
    );
  });
});
