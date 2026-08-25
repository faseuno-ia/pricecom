// GATE A2 — Paso 6: transporte de rawData ScrapedProduct → ExtractedProduct.
// Prueba la función pura extraída del seam de persistencia del worker
// (worker/src/index.ts createMany) SIN DB: verifica que rawData llega intacto.
import { describe, it, expect } from "vitest";
import { mapScrapedToExtractedProductInput } from "@/lib/scraper/extracted-product-input";
import type { ScrapedProduct } from "@/lib/scraper/scraper.service";

function crossProductScraped(): ScrapedProduct {
  return {
    sku: "3048-9",
    name: "Producto cross",
    description: null,
    wholesalePrice: 8228,
    oldPrice: null,
    stock: null,
    category: null,
    brand: null,
    productUrl: "https://differenttouch.com.ar/productos/x/",
    imageUrl: "//img/a.webp",
    rawData: {
      source: "TIENDANUBE_LS_VARIANTS_SKU_FIRST",
      classification: "CROSS_PRODUCT_CONFLICT",
      groupType: "CROSS_PRODUCT_CONFLICT",
      crossProductSetKey: "167510197::170598112",
      canonicalWinner: { productId: "167510197", variantId: "643792286", originalCaptureIndex: 3 },
      flags: ["CROSS_PRODUCT_CONFLICT"],
      variants: [
        { productId: "167510197", variantId: "643792286", idsValid: true, rawSku: "3048-9", trimmedSku: "3048-9" },
        { productId: "170598112", variantId: "643792999", idsValid: true, rawSku: "3048-9", trimmedSku: "3048-9" },
      ],
    },
    externalProductId: "167510197",
    externalVariantId: "643792286",
  };
}

// C2-MINI-A · el mapper exige UN instante de observación por attempt. Estos tests no afirman nada
// sobre taxonomía: la constante sólo satisface el contrato, sin cambiar ninguna aserción previa.
const ATTEMPT_AT = new Date("2026-08-24T00:00:00.000Z");

describe("mapScrapedToExtractedProductInput — preservación de rawData", () => {
  it("mapea los campos canónicos del ganador", () => {
    const out = mapScrapedToExtractedProductInput(crossProductScraped(), "job1", "prov1", ATTEMPT_AT);
    expect(out.jobId).toBe("job1");
    expect(out.providerId).toBe("prov1");
    expect(out.sku).toBe("3048-9");
    expect(out.name).toBe("Producto cross");
    expect(out.wholesalePrice).toBe(8228);
    expect(out.imageUrl).toBe("//img/a.webp");
  });

  it('name vacío → "Sin nombre" (comportamiento byte-equivalente al worker)', () => {
    const p = { ...crossProductScraped(), name: "" };
    expect(mapScrapedToExtractedProductInput(p, "j", "pr", ATTEMPT_AT).name).toBe("Sin nombre");
  });

  it("rawData conserva las dos variantes cross-product", () => {
    const raw = mapScrapedToExtractedProductInput(crossProductScraped(), "j", "pr", ATTEMPT_AT).rawData as Record<string, unknown>;
    const variants = raw.variants as unknown[];
    expect(variants.length).toBe(2);
  });

  it("IDs se conservan como strings dentro de rawData", () => {
    const raw = mapScrapedToExtractedProductInput(crossProductScraped(), "j", "pr", ATTEMPT_AT).rawData as Record<string, unknown>;
    const v = (raw.variants as Record<string, unknown>[])[0];
    expect(typeof v.productId).toBe("string");
    expect(typeof v.variantId).toBe("string");
    const winner = raw.canonicalWinner as Record<string, unknown>;
    expect(typeof winner.productId).toBe("string");
  });

  it("conserva flags, crossProductSetKey y canonicalWinner", () => {
    const raw = mapScrapedToExtractedProductInput(crossProductScraped(), "j", "pr", ATTEMPT_AT).rawData as Record<string, unknown>;
    expect(raw.flags).toEqual(["CROSS_PRODUCT_CONFLICT"]);
    expect(raw.crossProductSetKey).toBe("167510197::170598112");
    expect((raw.canonicalWinner as Record<string, unknown>).variantId).toBe("643792286");
  });

  it("rawData es JSON.stringify-able (sin BigInt) y sin secretos", () => {
    const raw = mapScrapedToExtractedProductInput(crossProductScraped(), "j", "pr", ATTEMPT_AT).rawData;
    let s = "";
    expect(() => { s = JSON.stringify(raw); }).not.toThrow();
    expect(/password|cookie|token|authorization|bearer|storageState/i.test(s)).toBe(false);
  });

  it("preserva referencia/estructura de rawData sin recortar claves", () => {
    const src = crossProductScraped();
    const out = mapScrapedToExtractedProductInput(src, "j", "pr", ATTEMPT_AT);
    expect(out.rawData).toEqual(src.rawData);
  });
});
