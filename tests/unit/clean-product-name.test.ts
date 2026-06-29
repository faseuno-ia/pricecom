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

describe("cleanProductName — código entre paréntesis al inicio (OESTECH)", () => {
  // Quita un código interno "(CODE) " al inicio. Conservador: CODE en MAYÚSCULAS
  // /dígitos/[-._], 2-20 chars, CON al menos un dígito o separador (-._) → así un
  // código (BLT-078, ARO30RGB) se distingue de una palabra comercial.
  it("quita (ARO30RGB) inicial", () => {
    expect(cleanProductName("(ARO30RGB) ARO LED RGB 30CM")).toBe("ARO LED RGB 30CM");
  });
  it("quita (BLT-078) inicial (código con guion)", () => {
    expect(cleanProductName("(BLT-078) PRODUCTO X")).toBe("PRODUCTO X");
  });
  it("quita (BA22) inicial", () => {
    expect(cleanProductName("(BA22) BALANZA PRECISION")).toBe("BALANZA PRECISION");
  });

  // Negativos obligatorios — NO debe tocar:
  it("NO quita (Combo x2) (espacio + minúscula)", () => {
    expect(cleanProductName("(Combo x2) AURICULARES")).toBe("(Combo x2) AURICULARES");
  });
  it("NO quita (Oferta) (minúscula)", () => {
    expect(cleanProductName("(Oferta) PRODUCTO")).toBe("(Oferta) PRODUCTO");
  });
  it("NO quita (Nuevo) (minúscula)", () => {
    expect(cleanProductName("(Nuevo) PRODUCTO")).toBe("(Nuevo) PRODUCTO");
  });
  it("NO quita (Pack especial) (espacio + minúscula)", () => {
    expect(cleanProductName("(Pack especial) PRODUCTO")).toBe("(Pack especial) PRODUCTO");
  });
  it("NO quita paréntesis demasiado largo (>20)", () => {
    expect(cleanProductName("(1234567890123456789012345) PRODUCTO")).toBe(
      "(1234567890123456789012345) PRODUCTO"
    );
  });
  it("NO quita palabra MAYÚSCULA sin dígito/guion (ej. (OFERTA))", () => {
    expect(cleanProductName("(OFERTA) PRODUCTO")).toBe("(OFERTA) PRODUCTO");
  });
  it("NO toca paréntesis que no está al inicio", () => {
    expect(cleanProductName("PRODUCTO (ARO30RGB)")).toBe("PRODUCTO (ARO30RGB)");
  });
  it("NO rompe guion interno", () => {
    expect(cleanProductName("CABLE USB-C 1M")).toBe("CABLE USB-C 1M");
    expect(cleanProductName("ADAPTADOR HDMI - VGA")).toBe("ADAPTADOR HDMI - VGA");
  });

  // Combinación: código inicial + guiones basura al final.
  it("quita código inicial Y guiones finales juntos", () => {
    expect(cleanProductName("(ARO36B) ARO LED 36CM BLANCO - -  -")).toBe(
      "ARO LED 36CM BLANCO"
    );
  });
});
