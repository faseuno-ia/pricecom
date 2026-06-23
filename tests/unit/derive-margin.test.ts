// TDD — derivación de manualMargin a partir del "precio de venta" del Excel.
//
// El importador NO debe congelar finalPrice por una columna de precio de venta:
// debe derivar el margen implícito (recalculable). La derivación es la inversa
// EXACTA del pricing-engine: effectiveCost = round2(ws × (1 − disc/100)),
// manualMargin = (webPrice / effectiveCost − 1) × 100. Round-trip < $0.01.

import { describe, it, expect } from "vitest";
import { deriveMarginFromWebPrice } from "@/lib/catalog/derive-margin";

// Recalc que haría el motor con el margen derivado (rounding "NONE"):
// effectiveCost × (1 + margin/100), con el MISMO effectiveCost redondeado.
function engineRecalc(ws: number, disc: number, margin: number): number {
  const effectiveCost = Math.round(ws * (1 - disc / 100) * 100) / 100;
  return effectiveCost * (1 + margin / 100);
}

describe("deriveMarginFromWebPrice — round-trip", () => {
  it("discount 0: ws=100, web=150 → margin 50, recalc 150", () => {
    const m = deriveMarginFromWebPrice(150, 100, 0);
    expect(m).not.toBeNull();
    expect(m!).toBeCloseTo(50, 6);
    expect(engineRecalc(100, 0, m!)).toBeCloseTo(150, 2);
  });

  it("discount 40 (LEDMOMENTS): ws=100, web=90 → effectiveCost 60, margin 50, recalc 90", () => {
    // Con la fórmula MALA (web/ws−1) daría −10 → recalc ≠ 90. Este test lo caza.
    const m = deriveMarginFromWebPrice(90, 100, 40);
    expect(m!).toBeCloseTo(50, 6);
    expect(engineRecalc(100, 40, m!)).toBeCloseTo(90, 2);
  });

  it("valores no redondos: ws=99.99, disc=12, web=129.99 → delta < $0.01", () => {
    const m = deriveMarginFromWebPrice(129.99, 99.99, 12);
    expect(m).not.toBeNull();
    expect(Math.abs(engineRecalc(99.99, 12, m!) - 129.99)).toBeLessThan(0.01);
  });

  it("otro no redondo: ws=1234.56, disc=37, web=1999.99 → delta < $0.01", () => {
    const m = deriveMarginFromWebPrice(1999.99, 1234.56, 37);
    expect(m).not.toBeNull();
    expect(Math.abs(engineRecalc(1234.56, 37, m!) - 1999.99)).toBeLessThan(0.01);
  });
});

describe("deriveMarginFromWebPrice — no derivable → null", () => {
  it("wholesalePrice null → null", () => {
    expect(deriveMarginFromWebPrice(150, null, 0)).toBeNull();
  });
  it("wholesalePrice 0 → null", () => {
    expect(deriveMarginFromWebPrice(150, 0, 0)).toBeNull();
  });
  it("webPrice null → null", () => {
    expect(deriveMarginFromWebPrice(null, 100, 0)).toBeNull();
  });
  it("webPrice 0 → null", () => {
    expect(deriveMarginFromWebPrice(0, 100, 0)).toBeNull();
  });
  it("discount 100 → effectiveCost 0 → null", () => {
    expect(deriveMarginFromWebPrice(150, 100, 100)).toBeNull();
  });
});

describe("deriveMarginFromWebPrice — margen negativo permitido", () => {
  it("web < effectiveCost (venta bajo costo): ws=100, disc=0, web=80 → margin -20", () => {
    const m = deriveMarginFromWebPrice(80, 100, 0);
    expect(m!).toBeCloseTo(-20, 6);
  });
});
