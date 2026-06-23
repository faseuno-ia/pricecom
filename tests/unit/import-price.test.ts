// TDD — decisión de precios del importador (default seguro: derivar margen, no
// congelar). Función pura que ambas superficies (API route + script CLI) usan
// para decidir qué escribir a partir del precio de venta del Excel.

import { describe, it, expect } from "vitest";
import { resolveImportSalePrice } from "@/lib/catalog/import-price";
import type { FreezeSignals } from "@/lib/catalog/involuntary-freeze";

const involuntary: FreezeSignals = {
  finalPrice: 200,
  wholesalePrice: 100,
  manualMargin: null,
  manualSourceNote: null,
  sourceType: "IMPORTED",
};

describe("resolveImportSalePrice — default deriva margen, NO congela", () => {
  it("con webPrice + costo: devuelve manualMargin, sin congelar finalPrice", () => {
    const r = resolveImportSalePrice({
      webPrice: 150,
      wholesalePrice: 100,
      listDiscountPercent: 0,
      existing: null,
    });
    expect(r.manualMargin).toBeCloseTo(50, 6);
    expect(r.derivable).toBe(true);
    // El resultado nunca propone escribir finalPrice (no existe ese campo en el out).
    expect(r).not.toHaveProperty("finalPrice");
  });

  it("usa listDiscountPercent del proveedor (40%): margin 50, no -10", () => {
    const r = resolveImportSalePrice({
      webPrice: 90,
      wholesalePrice: 100,
      listDiscountPercent: 40,
      existing: null,
    });
    expect(r.manualMargin).toBeCloseTo(50, 6);
  });
});

describe("resolveImportSalePrice — limpieza de freeze involuntario", () => {
  it("limpia finalPrice si el freeze previo era involuntario y hay precio de venta", () => {
    const r = resolveImportSalePrice({
      webPrice: 150,
      wholesalePrice: 100,
      listDiscountPercent: 0,
      existing: involuntary,
    });
    expect(r.clearFinalPrice).toBe(true);
  });

  it("NO limpia finalPrice si manualSourceNote existe (intencional)", () => {
    const r = resolveImportSalePrice({
      webPrice: 150,
      wholesalePrice: 100,
      listDiscountPercent: 0,
      existing: { ...involuntary, manualSourceNote: "precio ancla" },
    });
    expect(r.clearFinalPrice).toBe(false);
  });

  it("NO limpia finalPrice si manualMargin existe (intencional)", () => {
    const r = resolveImportSalePrice({
      webPrice: 150,
      wholesalePrice: 100,
      listDiscountPercent: 0,
      existing: { ...involuntary, manualMargin: 40 },
    });
    expect(r.clearFinalPrice).toBe(false);
  });

  it("NO limpia finalPrice si la fila NO trae precio de venta", () => {
    const r = resolveImportSalePrice({
      webPrice: null,
      wholesalePrice: 100,
      listDiscountPercent: 0,
      existing: involuntary,
    });
    expect(r.clearFinalPrice).toBe(false);
  });

  // Invariante: si no se pudo derivar un margen válido, NUNCA limpiar finalPrice
  // (no dejar el producto sin precio ni override).
  it("NO limpia finalPrice si existing es freeze involuntario pero no se pudo derivar margen por discount=100", () => {
    const r = resolveImportSalePrice({
      webPrice: 150,
      wholesalePrice: 100,
      listDiscountPercent: 100,
      existing: involuntary,
    });

    expect(r.derivable).toBe(false);
    expect(r.manualMargin).toBeNull();
    expect(r.clearFinalPrice).toBe(false);
  });

  it("NO limpia finalPrice si wholesalePrice es null (no derivable)", () => {
    const r = resolveImportSalePrice({
      webPrice: 150,
      wholesalePrice: null,
      listDiscountPercent: 0,
      existing: involuntary,
    });
    expect(r.derivable).toBe(false);
    expect(r.clearFinalPrice).toBe(false);
  });

  it("NO limpia finalPrice si wholesalePrice es 0 (no derivable)", () => {
    const r = resolveImportSalePrice({
      webPrice: 150,
      wholesalePrice: 0,
      listDiscountPercent: 0,
      existing: involuntary,
    });
    expect(r.derivable).toBe(false);
    expect(r.clearFinalPrice).toBe(false);
  });
});

describe("resolveImportSalePrice — bordes", () => {
  it("sin costo → no derivable, sin margen, sin limpiar", () => {
    const r = resolveImportSalePrice({
      webPrice: 150,
      wholesalePrice: null,
      listDiscountPercent: 0,
      existing: involuntary,
    });
    expect(r.derivable).toBe(false);
    expect(r.manualMargin).toBeNull();
    expect(r.clearFinalPrice).toBe(false);
  });

  it("margen negativo permitido y flag", () => {
    const r = resolveImportSalePrice({
      webPrice: 80,
      wholesalePrice: 100,
      listDiscountPercent: 0,
      existing: null,
    });
    expect(r.manualMargin).toBeCloseTo(-20, 6);
    expect(r.negativeMargin).toBe(true);
  });
});
