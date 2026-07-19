// TDD — cleanProductName debe quitar la basura de GUIONES DE RELLENO al final
// del nombre (ej. OESTECH: "NOMBRE - -  -  -"), de forma CONSERVADORA: solo el
// trailing, sin tocar guiones internos legítimos. Función compartida por TODOS
// los proveedores → el fix no debe romper nombres válidos.

import { describe, it, expect } from "vitest";
import { cleanProductName, fixMojibakeCp1252Utf8 } from "@/lib/utils";

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

describe("cleanProductName — código (CODE)TEXTO SIN espacio (OESTECH)", () => {
  // Misma guarda, pero el código puede venir pegado al texto (sin espacio tras ')').
  it("quita (RD-007) pegado", () => {
    expect(cleanProductName("(RD-007)CAMIONETA CROSS 4X4")).toBe("CAMIONETA CROSS 4X4");
  });
  it("quita (ARO30RGB) pegado", () => {
    expect(cleanProductName("(ARO30RGB)ARO LED RGB 30CM")).toBe("ARO LED RGB 30CM");
  });
  it("quita (BA22) pegado", () => {
    expect(cleanProductName("(BA22)BALANZA PRECISION")).toBe("BALANZA PRECISION");
  });

  // Negativos obligatorios (sin espacio) — NO debe tocar:
  it("NO quita (Oferta) pegado (minúscula)", () => {
    expect(cleanProductName("(Oferta)PRODUCTO")).toBe("(Oferta)PRODUCTO");
  });
  it("NO quita (Nuevo) pegado (minúscula)", () => {
    expect(cleanProductName("(Nuevo)PRODUCTO")).toBe("(Nuevo)PRODUCTO");
  });
  it("NO quita (OFERTA) pegado (mayúscula sin dígito/sep)", () => {
    expect(cleanProductName("(OFERTA)PRODUCTO")).toBe("(OFERTA)PRODUCTO");
  });
  it("NO quita (Combo x2) pegado (espacio + minúscula)", () => {
    expect(cleanProductName("(Combo x2)PRODUCTO")).toBe("(Combo x2)PRODUCTO");
  });
  it("NO quita (Pack especial) pegado", () => {
    expect(cleanProductName("(Pack especial)PRODUCTO")).toBe("(Pack especial)PRODUCTO");
  });
  it("NO quita paréntesis no-inicial pegado", () => {
    expect(cleanProductName("PRODUCTO (RD-007)CAMIONETA")).toBe("PRODUCTO (RD-007)CAMIONETA");
  });
  it("NO quita código largo (>20) pegado", () => {
    expect(cleanProductName("(1234567890123456789012345)PRODUCTO")).toBe(
      "(1234567890123456789012345)PRODUCTO"
    );
  });
  it("NO quita si no hay texto real después del código", () => {
    expect(cleanProductName("(RD-007)")).toBe("(RD-007)");
    // trailing spaces se trimean por contrato, pero el código NO se quita
    expect(cleanProductName("(RD-007)   ")).toBe("(RD-007)");
  });
});

// TDD — GATE OESTECH: el mojibake viene del ORIGEN (UTF-8 servido, pero el HTML
// crudo trae bytes UTF-8 mal interpretados como Windows-1252 y re-codificados).
// cleanProductName corrige nombres/descripciones; NUNCA se aplica a SKU.
describe("cleanProductName — mojibake CP1252/UTF-8 (OESTECH)", () => {
  it("corrige ° mal codificado (Â°)", () => {
    expect(
      cleanProductName("SOPORTE PROFESIONAL SEGUIMIENTO 360Â°")
    ).toBe("SOPORTE PROFESIONAL SEGUIMIENTO 360°");
  });
  it("corrige ° dentro de un nombre largo", () => {
    expect(
      cleanProductName("ESPEJO BASE 180Â° ZOOM X2 + X3 LUZ")
    ).toBe("ESPEJO BASE 180° ZOOM X2 + X3 LUZ");
  });
  it("corrige Ñ mal codificada (Ã‘) — DISEÑOS", () => {
    expect(
      cleanProductName("PACK VENTILADOR INFANTIL MANUAL X20 UNID DISEÃ‘OS")
    ).toBe("PACK VENTILADOR INFANTIL MANUAL X20 UNID DISEÑOS");
  });
  it("corrige Ñ mal codificada (Ã‘) — DISEÑO", () => {
    expect(
      cleanProductName("RELOJ LED TACTIL INFANTIL C/ DISEÃ‘O SILICONA")
    ).toBe("RELOJ LED TACTIL INFANTIL C/ DISEÑO SILICONA");
  });
  it("corrige Ñ mal codificada (Ã‘) — NIÑOS", () => {
    expect(
      cleanProductName("RELOJ SMARTWATCH NIÃ‘OS GPS S.O.S CAMARA SIM CARD")
    ).toBe("RELOJ SMARTWATCH NIÑOS GPS S.O.S CAMARA SIM CARD");
  });
  it("corrige Ñ mal codificada (Ã‘) — MOÑO", () => {
    expect(
      cleanProductName("POP IT MOÃ‘O JUEGO VELOCIDAD")
    ).toBe("POP IT MOÑO JUEGO VELOCIDAD");
  });
});

describe("cleanProductName — NO rompe nombres ya correctos (guarda U+FFFD)", () => {
  it("no toca Ñ ya correcta (test crítico)", () => {
    expect(cleanProductName("DISEÑO INFANTIL")).toBe("DISEÑO INFANTIL");
  });
  it("no toca Ñ ya correcta — NIÑOS", () => {
    expect(cleanProductName("NIÑOS GPS")).toBe("NIÑOS GPS");
  });
  it("no toca ° ya correcto", () => {
    expect(cleanProductName("ESPEJO 180°")).toBe("ESPEJO 180°");
  });
  it("no toca comillas de pulgadas", () => {
    expect(cleanProductName('PARLANTE 3" BT + USB')).toBe('PARLANTE 3" BT + USB');
  });
  it("no toca rango de pulgadas", () => {
    expect(cleanProductName('SOPORTE TV 14"-42"')).toBe('SOPORTE TV 14"-42"');
  });
  it("no toca +PICOS", () => {
    expect(cleanProductName("COMPRESOR +PICOS")).toBe("COMPRESOR +PICOS");
  });
  it("no toca un nombre ASCII normal", () => {
    expect(cleanProductName("PRODUCTO NORMAL")).toBe("PRODUCTO NORMAL");
  });
});

// Tests directos del helper — aísla las dos guardas obligatorias.
describe("fixMojibakeCp1252Utf8 — helper puro", () => {
  it("corrige Ã‘ → Ñ", () => {
    expect(fixMojibakeCp1252Utf8("DISEÃ‘O")).toBe("DISEÑO");
  });
  it("corrige Â° → °", () => {
    expect(fixMojibakeCp1252Utf8("180Â°")).toBe("180°");
  });
  it("guarda U+FFFD: texto ya correcto con Ñ vuelve intacto", () => {
    expect(fixMojibakeCp1252Utf8("DISEÑO INFANTIL")).toBe("DISEÑO INFANTIL");
  });
  it("guarda U+FFFD: ° ya correcto vuelve intacto", () => {
    expect(fixMojibakeCp1252Utf8("180°")).toBe("180°");
  });
  it("no representable en CP1252: devuelve original (emoji)", () => {
    expect(fixMojibakeCp1252Utf8("PRODUCTO 😀")).toBe("PRODUCTO 😀");
  });
  it("string ASCII vuelve igual", () => {
    expect(fixMojibakeCp1252Utf8("PRODUCTO NORMAL")).toBe("PRODUCTO NORMAL");
  });
  it("string vacío", () => {
    expect(fixMojibakeCp1252Utf8("")).toBe("");
  });
});
