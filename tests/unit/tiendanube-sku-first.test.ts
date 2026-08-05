// GATE A2 — extractor TiendaNube SKU-first. Módulo puro, sin DB/red/sitio.
import { describe, it, expect } from "vitest";
import {
  parseArgArsPrice,
  normalizeExternalId,
  mapLsVariantToReducedRow,
  groupSkuFirst,
  resolveExtractionMode,
  type TnReducedRow,
} from "@/lib/scraper/tiendanube-sku-first";

// Respeta presencia de clave: un `null` explícito NO se reemplaza por el default
// (usar ?? convertiría null→default y falsearía los casos "sin precio"/"sin imagen").
function pick<K extends keyof TnReducedRow>(o: Partial<TnReducedRow>, k: K, def: TnReducedRow[K]): TnReducedRow[K] {
  return k in o ? (o[k] as TnReducedRow[K]) : def;
}
function row(o: Partial<TnReducedRow>): TnReducedRow {
  return {
    sourcePageIndex: pick(o, "sourcePageIndex", 0),
    sourceVariantIndex: pick(o, "sourceVariantIndex", 0),
    productId: pick(o, "productId", "100"),
    variantId: pick(o, "variantId", "1000"),
    rawSku: pick(o, "rawSku", "SKU"),
    productName: pick(o, "productName", "Nombre"),
    variantName: pick(o, "variantName", null),
    productUrl: pick(o, "productUrl", "https://x.com/p"),
    imageUrl: pick(o, "imageUrl", "//img/a.webp"),
    priceNumber: pick(o, "priceNumber", 100),
    priceWithoutTaxes: pick(o, "priceWithoutTaxes", "$82,64"),
    stock: pick(o, "stock", null),
    available: pick(o, "available", true),
    variantAttributes: pick(o, "variantAttributes", {}),
  };
}

describe("resolveExtractionMode — activación del modo (sin acoplamiento a DB)", () => {
  it("undefined → LEGACY sin clave warning", () => {
    const r = resolveExtractionMode(undefined);
    expect(r).toStrictEqual({ mode: "LEGACY" });
    expect("warning" in r).toBe(false);
  });
  it("null → LEGACY sin clave warning", () => {
    const r = resolveExtractionMode(null);
    expect(r).toStrictEqual({ mode: "LEGACY" });
    expect("warning" in r).toBe(false);
  });
  it("valor exacto → modo nuevo sin clave warning", () => {
    const r = resolveExtractionMode("TIENDANUBE_LS_VARIANTS_SKU_FIRST");
    expect(r).toStrictEqual({ mode: "TIENDANUBE_LS_VARIANTS_SKU_FIRST" });
    expect("warning" in r).toBe(false);
  });
  it("valor desconocido → throw fail-loud (field + valor)", () => {
    expect(() => resolveExtractionMode("SOMETHING_ELSE")).toThrow(/field=extractionMode/);
    expect(() => resolveExtractionMode("SOMETHING_ELSE")).toThrow(/SOMETHING_ELSE/);
  });
  it("no acepta variantes por case/espacios → throw (no normaliza)", () => {
    expect(() => resolveExtractionMode("tiendanube_ls_variants_sku_first")).toThrow(/field=extractionMode/);
    // el whitespace circundante queda visible en el mensaje (JSON.stringify): no se recorta al valor exacto
    expect(() => resolveExtractionMode(" TIENDANUBE_LS_VARIANTS_SKU_FIRST ")).toThrow(
      /" TIENDANUBE_LS_VARIANTS_SKU_FIRST "/
    );
  });
  it("tipos no-string → LEGACY, sin clave warning, sin throw", () => {
    for (const v of [1, {}] as unknown[]) {
      const r = resolveExtractionMode(v);
      expect(r).toStrictEqual({ mode: "LEGACY" });
      expect("warning" in r).toBe(false);
    }
  });
});

describe("parseArgArsPrice — parser argentino estricto", () => {
  it('"$6.800,00" → 6800', () => expect(parseArgArsPrice("$6.800,00").number).toBe(6800));
  it('"$8.228,00" → 8228', () => expect(parseArgArsPrice("$8.228,00").number).toBe(8228));
  it("centavos: \"$6.800,50\" → 6800.5", () => expect(parseArgArsPrice("$6.800,50").number).toBe(6800.5));
  it("con espacios/símbolo: \"  $ 1.234,56 \" → 1234.56", () => expect(parseArgArsPrice("  $ 1.234,56 ").number).toBe(1234.56));
  it("formato inválido → null + error", () => { const r = parseArgArsPrice("abc"); expect(r.number).toBe(null); expect(r.error).toBe(true); });
  it("vacío/null → null sin error", () => { expect(parseArgArsPrice("").number).toBe(null); expect(parseArgArsPrice("").error).toBe(false); expect(parseArgArsPrice(null).number).toBe(null); });
  it("no devuelve 0 ante error", () => expect(parseArgArsPrice("$$$").number).not.toBe(0));
  it("conserva raw", () => expect(parseArgArsPrice("$6.800,00").raw).toBe("$6.800,00"));
});

describe("normalizeExternalId — decimal positivo, string", () => {
  it("string '2' → valid, '2'", () => expect(normalizeExternalId("2")).toEqual({ valid: true, str: "2" }));
  it("number 10 → valid, '10'", () => expect(normalizeExternalId(10)).toEqual({ valid: true, str: "10" }));
  it("'0' → inválido", () => expect(normalizeExternalId("0").valid).toBe(false));
  it("negativo → inválido", () => expect(normalizeExternalId(-5).valid).toBe(false));
  it("decimal → inválido", () => expect(normalizeExternalId(1.5).valid).toBe(false));
  it("null/undefined → inválido", () => { expect(normalizeExternalId(null).valid).toBe(false); expect(normalizeExternalId(undefined).valid).toBe(false); });
});

describe("mapLsVariantToReducedRow — reconciliación crudo → reducido (muestra Gate 1C)", () => {
  it("americano 017-30 se transforma exactamente al shape reducido", () => {
    const rawVariant = {
      id: 643792286, product_id: 170002697, sku: "017-30",
      option0: "Piel", option1: null, option2: null,
      price_short: "$8.228,00", price_long: "$8.228,00 ARS", price_number: 8228, price_number_raw: 822800,
      price_without_taxes: "$6.800,00", promotional_price_number: null,
      stock: null, available: true, image: 477913194,
      image_url: "//dcdn-us.mitiendanube.com/stores/003/101/326/products/ff6d92b4224e456bc03ac8aed4573a822aa953631-152129c0c85a79aedd16845960112300-1024-1024.webp",
    };
    const out = mapLsVariantToReducedRow(rawVariant, {
      sourcePageIndex: 144, sourceVariantIndex: 0,
      productId: 170002697, productName: "Consolador Con ventosa Americano",
      productUrl: "https://differenttouch.com.ar/productos/consolador-con-ventosa-americano/",
      domLabels: ["Color", "Color: Piel", "Color: Negro"],
      capturedAt: "2026-07-19T23:00:12.360Z",
    });
    expect(out).toEqual({
      sourcePageIndex: 144, sourceVariantIndex: 0, capturedAt: "2026-07-19T23:00:12.360Z",
      productId: 170002697, variantId: 643792286, rawSku: "017-30", trimmedSku: "017-30",
      productName: "Consolador Con ventosa Americano", variantName: "Consolador Con ventosa Americano - Piel",
      productUrl: "https://differenttouch.com.ar/productos/consolador-con-ventosa-americano/",
      option0Name: "Color", option0Value: "Piel", option1Name: "Color: Piel", option1Value: null,
      option2Name: "Color: Negro", option2Value: null, variantAttributes: { Color: "Piel" },
      priceNumber: 8228, priceNumberRaw: 822800, priceShort: "$8.228,00", priceLong: "$8.228,00 ARS",
      priceWithoutTaxes: "$6.800,00", priceWithoutTaxesNumber: null, priceWithoutTaxesRaw: null,
      promotionalPriceNumber: null, stock: null, available: true, imageId: 477913194,
      imageUrl: rawVariant.image_url, barcode: null, handle: null,
      productHandle: "consolador-con-ventosa-americano", descriptionSnippet: null,
    });
  });
});

describe("groupSkuFirst — normalización SKU + cuarentena", () => {
  it("1 variante → 1 producto", () => { const r = groupSkuFirst([row({ rawSku: "A" })]); expect(r.products.length).toBe(1); expect(r.products[0].sku).toBe("A"); });
  it("SKU con espacios externos se trimea", () => expect(groupSkuFirst([row({ rawSku: " A-1 " })]).products[0].sku).toBe("A-1"));
  it("case se conserva", () => { const r = groupSkuFirst([row({ rawSku: "aBc", productId: "1" }), row({ rawSku: "ABC", productId: "2" })]); expect(r.products.length).toBe(2); });
  it("espacios internos se conservan", () => expect(groupSkuFirst([row({ rawSku: "A  B" })]).products[0].sku).toBe("A  B"));
  it("SKU null → cuarentena", () => { const r = groupSkuFirst([row({ rawSku: null })]); expect(r.products.length).toBe(0); expect(r.quarantine.length).toBe(1); });
  it("SKU vacío → cuarentena", () => expect(groupSkuFirst([row({ rawSku: "" })]).quarantine.length).toBe(1));
  it("SKU whitespace → cuarentena", () => expect(groupSkuFirst([row({ rawSku: "   " })]).quarantine.length).toBe(1));
  it("variantId NO se usa como SKU", () => expect(groupSkuFirst([row({ rawSku: "S", variantId: "999" })]).products[0].sku).toBe("S"));
  it("productId NO se usa como SKU", () => expect(groupSkuFirst([row({ rawSku: "S", productId: "888" })]).products[0].sku).toBe("S"));
});

describe("groupSkuFirst — agrupación, ganador determinístico, cross-product", () => {
  const sameSku = (pid: string, vid: string, i: number, o: Partial<TnReducedRow> = {}) => row({ rawSku: "DUP", productId: pid, variantId: vid, sourceVariantIndex: i, ...o });
  it("dos same-parent → un producto, todos en rawData", () => {
    const r = groupSkuFirst([sameSku("100", "1", 0), sameSku("100", "2", 1)]);
    expect(r.products.length).toBe(1);
    expect((r.products[0].rawData as any).variants.length).toBe(2);
    expect((r.products[0].rawData as any).groupType).toBe("SAME_PARENT");
  });
  it("dos cross-product → un producto, marcado conflicto, todas las variantes preservadas", () => {
    const r = groupSkuFirst([sameSku("200", "1", 0), sameSku("100", "2", 1)]);
    expect(r.products.length).toBe(1);
    expect((r.products[0].rawData as any).classification).toBe("CROSS_PRODUCT_CONFLICT");
    expect((r.products[0].rawData as any).variants.length).toBe(2);
  });
  it("ganador por productId NUMÉRICO no lexicográfico: '2' antes que '10'", () => {
    const r = groupSkuFirst([sameSku("10", "1", 0), sameSku("2", "1", 1)]);
    expect((r.products[0].rawData as any).canonicalWinner.productId).toBe("2");
  });
  it("desempate por variantId BigInt", () => {
    const r = groupSkuFirst([sameSku("100", "10", 0), sameSku("100", "2", 1)]);
    expect((r.products[0].rawData as any).canonicalWinner.variantId).toBe("2");
  });
  it("desempate por originalCaptureIndex", () => {
    const r = groupSkuFirst([sameSku("100", "5", 0), sameSku("100", "5", 1)]);
    expect((r.products[0].rawData as any).canonicalWinner).toBeTruthy();
  });
  it("IDs quedan como strings; JSON.stringify no rompe", () => {
    const r = groupSkuFirst([sameSku("200", "1", 0), sameSku("100", "2", 1)]);
    expect(typeof (r.products[0].rawData as any).canonicalWinner.productId).toBe("string");
    expect(() => JSON.stringify(r.products[0].rawData)).not.toThrow();
  });
  it("clave cross-product de dos IDs ordenada", () => {
    const r = groupSkuFirst([sameSku("170598112", "1", 0), sameSku("167510197", "2", 1)]);
    expect((r.products[0].rawData as any).crossProductSetKey).toBe("167510197::170598112");
  });
  it("clave cross-product de tres IDs ordenada; A::B == B::A", () => {
    const r1 = groupSkuFirst([sameSku("300", "1", 0), sameSku("100", "2", 1), sameSku("200", "3", 2)]);
    expect((r1.products[0].rawData as any).crossProductSetKey).toBe("100::200::300");
  });
});

describe("groupSkuFirst — precio bruto (wholesalePrice) + fallback + neto", () => {
  const g = (o: Partial<TnReducedRow>[]) => groupSkuFirst(o.map((x, i) => row({ rawSku: "P", productId: "100", variantId: String(i + 1), sourceVariantIndex: i, ...x })));
  it("bruto del ganador", () => expect(g([{ priceNumber: 8228 }]).products[0].wholesalePrice).toBe(8228));
  it("fallback: ganador sin precio → primer miembro con precio", () => {
    const r = g([{ productId: "100", priceNumber: null }, { productId: "101", priceNumber: 500 }]);
    // ganador = productId 100 (menor); no tiene precio → fallback al 500
    expect(r.products[0].wholesalePrice).toBe(500);
  });
  it("grupo sin bruto → null + MISSING_GROSS_PRICE", () => {
    const r = g([{ priceNumber: null }]);
    expect(r.products[0].wholesalePrice).toBe(null);
    expect((r.products[0].rawData as any).flags).toContain("MISSING_GROSS_PRICE");
  });
  it("neto parseado del ganador", () => {
    const r = g([{ priceWithoutTaxes: "$6.800,00" }]);
    expect((r.products[0].rawData as any).priceWithoutTaxes).toBe(6800);
  });
  it("neto inválido → null + NET_PRICE_PARSE_ERROR", () => {
    const r = g([{ priceWithoutTaxes: "xx" }]);
    expect((r.products[0].rawData as any).priceWithoutTaxes).toBe(null);
    expect((r.products[0].rawData as any).flags).toContain("NET_PRICE_PARSE_ERROR");
  });
});

describe("groupSkuFirst — stock/imagen/nombre/available", () => {
  it("producto agrupado siempre stock null", () => expect(groupSkuFirst([row({ stock: 5 })]).products[0].stock).toBe(null));
  it("availableAny/availableAll", () => {
    const r = groupSkuFirst([row({ rawSku: "Z", productId: "100", variantId: "1", available: true, sourceVariantIndex: 0 }), row({ rawSku: "Z", productId: "100", variantId: "2", available: false, sourceVariantIndex: 1 })]);
    expect((r.products[0].rawData as any).availableAny).toBe(true);
    expect((r.products[0].rawData as any).availableAll).toBe(false);
  });
  it("imagen del ganador; fallback si el ganador no tiene", () => {
    const r = groupSkuFirst([row({ rawSku: "I", productId: "100", variantId: "1", imageUrl: null, sourceVariantIndex: 0 }), row({ rawSku: "I", productId: "101", variantId: "2", imageUrl: "//img/b.webp", sourceVariantIndex: 1 })]);
    expect(r.products[0].imageUrl).toBe("//img/b.webp");
  });
  it("nombre del ganador; fallback si vacío", () => {
    const r = groupSkuFirst([row({ rawSku: "N", productId: "100", variantId: "1", productName: "", sourceVariantIndex: 0 }), row({ rawSku: "N", productId: "101", variantId: "2", productName: "Bueno", sourceVariantIndex: 1 })]);
    expect(r.products[0].name).toBe("Bueno");
  });
  it("grupo sin nombre utilizable → cuarentena", () => {
    const r = groupSkuFirst([row({ rawSku: "NN", productName: "" }), row({ rawSku: "NN", productName: "  " })]);
    expect(r.products.length).toBe(0);
    expect(r.quarantine.length).toBeGreaterThan(0);
  });
});

describe("groupSkuFirst — determinismo + rawData JSON-safe + sin secretos", () => {
  const dataset = [row({ rawSku: "B", productId: "10", variantId: "1", sourceVariantIndex: 0 }), row({ rawSku: "A", productId: "2", variantId: "1", sourceVariantIndex: 1 }), row({ rawSku: "B", productId: "3", variantId: "2", sourceVariantIndex: 2 })];
  it("resultado independiente del orden de entrada (IDs válidos)", () => {
    const a = groupSkuFirst(dataset);
    const b = groupSkuFirst([dataset[2], dataset[0], dataset[1]]);
    const key = (x: any) => x.products.map((p: any) => p.sku).sort();
    expect(key(a)).toEqual(key(b));
  });
  it("segunda ejecución → deep-equal", () => {
    expect(groupSkuFirst(dataset)).toEqual(groupSkuFirst(dataset));
  });
  it("rawData JSON-safe (sin BigInt) para todos", () => {
    const r = groupSkuFirst(dataset);
    for (const p of r.products) expect(() => JSON.stringify(p.rawData)).not.toThrow();
  });
  it("rawData no contiene claves de secretos", () => {
    const r = groupSkuFirst(dataset);
    const s = JSON.stringify(r.products.map((p) => p.rawData));
    expect(/password|cookie|token|authorization/i.test(s)).toBe(false);
  });
  it("cross-product NO bloquea (produce producto)", () => {
    const r = groupSkuFirst([row({ rawSku: "X", productId: "200", variantId: "1", sourceVariantIndex: 0 }), row({ rawSku: "X", productId: "100", variantId: "2", sourceVariantIndex: 1 })]);
    expect(r.products.length).toBe(1);
  });
});

describe("groupSkuFirst — confirmación de unidad de precio (ratio same-variant)", () => {
  it("ratios ~1.21 → PESOS_CONFIRMED", () => {
    const rows = [8228, 10010, 7480].map((pn, i) => row({ rawSku: "R" + i, productId: String(100 + i), variantId: "1", priceNumber: pn, priceWithoutTaxes: `$${Math.round((pn / 1.21)).toLocaleString("es-AR")}`, sourceVariantIndex: i }));
    const r = groupSkuFirst(rows);
    expect(r.diagnostics.priceUnitVerdict).toBe("PESOS_CONFIRMED");
    expect(r.diagnostics.priceUnitValidPairs).toBeGreaterThan(0);
  });
  it("ratios ~100 → PRICE_UNIT_UNCONFIRMED", () => {
    const rows = [row({ rawSku: "C1", priceNumber: 680000, priceWithoutTaxes: "$6.800,00" })];
    const r = groupSkuFirst(rows);
    expect(r.diagnostics.priceUnitVerdict).toBe("PRICE_UNIT_UNCONFIRMED");
  });
  it("el ratio usa bruto y neto de la MISMA variante; filas incompletas no cuentan", () => {
    const rows = [row({ rawSku: "OK", priceNumber: 121, priceWithoutTaxes: "$100,00" }), row({ rawSku: "NOPE", productId: "101", priceNumber: 100, priceWithoutTaxes: "xx" })];
    const r = groupSkuFirst(rows);
    expect(r.diagnostics.priceUnitValidPairs).toBe(1);
  });
});
