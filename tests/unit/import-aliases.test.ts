// TDD — los headers de "precio de venta" del Excel NO deben caer en el alias
// `finalPrice` (que congela). Deben ir a `salePrice`, que el importador usa para
// derivar margen. "PRECIO WEB (MAYORISTA)" sigue siendo costo.

import { describe, it, expect } from "vitest";
import { pickField, COL_ALIASES } from "@/lib/catalog/import-aliases";

describe("aliases — precio de venta va a `salePrice`, no a freeze", () => {
  it("'PRECIO WEB' → salePrice", () => {
    expect(pickField({ "PRECIO WEB": "150" }, "salePrice")).toBe("150");
  });
  it("'PRECIO FINAL' → salePrice", () => {
    expect(pickField({ "PRECIO FINAL": "150" }, "salePrice")).toBe("150");
  });
  it("'PRECIO VENTA' → salePrice", () => {
    expect(pickField({ "PRECIO VENTA": "150" }, "salePrice")).toBe("150");
  });

  it("ya NO existe la key de alias `finalPrice` (nada congela por header)", () => {
    expect(COL_ALIASES).not.toHaveProperty("finalPrice");
  });
});

describe("aliases — 'PRECIO WEB (MAYORISTA)' sigue siendo costo", () => {
  it("va a `cost`, no a `salePrice`", () => {
    expect(pickField({ "PRECIO WEB (MAYORISTA)": "100" }, "cost")).toBe("100");
    expect(pickField({ "PRECIO WEB (MAYORISTA)": "100" }, "salePrice")).toBe("");
  });
});
