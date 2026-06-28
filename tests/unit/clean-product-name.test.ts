// TDD — cleanProductName debe quitar la basura de GUIONES DE RELLENO al final
// del nombre (ej. OESTECH: "NOMBRE - -  -  -"), de forma CONSERVADORA: solo el
// trailing, sin tocar guiones internos legítimos. Función compartida por TODOS
// los proveedores → el fix no debe romper nombres válidos.

import { describe, it, expect } from "vitest";
import { cleanProductName } from "@/lib/utils";

describe("cleanProductName — trailing dashes (OESTECH)", () => {
  it("quita guiones de relleno al final", () => {
    expect(cleanProductName("AURICULAR A6S COLOR PRO OESTECH - -  -  -")).toBe(
      "AURICULAR A6S COLOR PRO OESTECH"
    );
  });

  it("quita un único guion final", () => {
    expect(cleanProductName("ARO LED 30CM 168 LEDS BLANCO -")).toBe(
      "ARO LED 30CM 168 LEDS BLANCO"
    );
  });

  it("preserva guiones internos en números/teléfonos (solo strip trailing)", () => {
    expect(
      cleanProductName("NUESTROS NUMEROS SON 11-6878-3909 Y 11-2466-3705 -")
    ).toBe("NUESTROS NUMEROS SON 11-6878-3909 Y 11-2466-3705");
  });
});

describe("cleanProductName — NO rompe nombres legítimos con guiones", () => {
  it("guion interno tipo USB-C", () => {
    expect(cleanProductName("CABLE USB-C 1M")).toBe("CABLE USB-C 1M");
  });
  it("separador legítimo HDMI - VGA", () => {
    expect(cleanProductName("ADAPTADOR HDMI - VGA")).toBe("ADAPTADOR HDMI - VGA");
  });
  it("descripción con color al final tras guion", () => {
    expect(cleanProductName("SOPORTE NOTEBOOK - NEGRO")).toBe("SOPORTE NOTEBOOK - NEGRO");
  });
});

describe("cleanProductName — comportamiento previo intacto", () => {
  it("null/undefined/'' → ''", () => {
    expect(cleanProductName(null)).toBe("");
    expect(cleanProductName(undefined)).toBe("");
    expect(cleanProductName("")).toBe("");
  });
  it("toma la primera línea no vacía", () => {
    expect(cleanProductName("\n  PRODUCTO X  \nsegunda linea")).toBe("PRODUCTO X");
  });
  it("sigue quitando el sufijo 'Código NNN'", () => {
    expect(cleanProductName("TALADRO PERCUTOR Código 1234")).toBe("TALADRO PERCUTOR");
    expect(cleanProductName("MOUSE GAMER Cod. 55")).toBe("MOUSE GAMER");
  });
  it("nombre limpio queda igual", () => {
    expect(cleanProductName("PARLANTE BLUETOOTH 10W")).toBe("PARLANTE BLUETOOTH 10W");
  });
});
