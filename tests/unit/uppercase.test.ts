// Tests del helper de mayuscularización del catálogo (regla universal: los
// datos de proveedor se guardan en MAYÚSCULAS). Valores esperados escritos a
// mano (no derivados de la misma función bajo test).

import { describe, it, expect } from "vitest";
import {
  toCatalogUpperCase,
  toCatalogUpperCaseOrNull,
} from "@/lib/catalog/uppercase";

describe("toCatalogUpperCase", () => {
  it("respeta acentos del español (es-AR)", () => {
    expect(toCatalogUpperCase("café con leche")).toBe("CAFÉ CON LECHE");
  });

  it("respeta la ñ", () => {
    expect(toCatalogUpperCase("ñoño")).toBe("ÑOÑO");
  });

  it("mayusculiza texto mixto con números y unidades", () => {
    expect(toCatalogUpperCase("Tira LED RGB 5m")).toBe("TIRA LED RGB 5M");
  });

  it("deja igual lo que ya está en mayúsculas", () => {
    expect(toCatalogUpperCase("ABC")).toBe("ABC");
  });
});

describe("toCatalogUpperCaseOrNull", () => {
  it("mayusculiza un string no vacío", () => {
    expect(toCatalogUpperCaseOrNull("café")).toBe("CAFÉ");
  });

  it("null → null", () => {
    expect(toCatalogUpperCaseOrNull(null)).toBeNull();
  });

  it("undefined → null", () => {
    expect(toCatalogUpperCaseOrNull(undefined)).toBeNull();
  });

  it("'' → null (vacío se normaliza a null)", () => {
    expect(toCatalogUpperCaseOrNull("")).toBeNull();
  });

  it("ya-mayúsculas → igual", () => {
    expect(toCatalogUpperCaseOrNull("ABC")).toBe("ABC");
  });
});
