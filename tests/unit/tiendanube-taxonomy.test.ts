import { describe, it, expect } from "vitest";
import { normalizeSupplierTaxonomy } from "../../lib/scraper/tiendanube-taxonomy";
import { mapLsVariantToReducedRow, groupSkuFirst, type TnReducedRow } from "../../lib/scraper/tiendanube-sku-first";

describe("C1 · normalizeSupplierTaxonomy (positional, observation-only)", () => {
  it("A) producto categorizado simple → ['A']", () => {
    expect(normalizeSupplierTaxonomy(["Inicio", "A", "Producto"])).toEqual({ path: ["A"], uncategorized: false });
  });
  it("B) taxonomía anidada → ['A','B','C'] (preserva jerarquía, no aplana)", () => {
    expect(normalizeSupplierTaxonomy(["Inicio", "A", "B", "C", "Producto"])).toEqual({ path: ["A", "B", "C"], uncategorized: false });
  });
  it("C) 'Productos' = uncategualizado observado (NO categoría real)", () => {
    expect(normalizeSupplierTaxonomy(["Inicio", "Productos", "Dilatador Anal"])).toEqual({ path: [], uncategorized: true });
  });
  it("D) breadcrumb ausente (null/undefined) → NOT_OBSERVED (null)", () => {
    expect(normalizeSupplierTaxonomy(null)).toBeNull();
    expect(normalizeSupplierTaxonomy(undefined)).toBeNull();
  });
  it("E) root-only / malformado (<2 nodos) → NOT_OBSERVED (null)", () => {
    expect(normalizeSupplierTaxonomy(["Inicio"])).toBeNull();
    expect(normalizeSupplierTaxonomy([])).toBeNull();
    expect(normalizeSupplierTaxonomy(["  ", ">"])).toBeNull(); // sólo separadores → limpian a <2
  });
  it("F) nombre de producto con acentos/puntuación no afecta el recorte posicional", () => {
    expect(normalizeSupplierTaxonomy(["Inicio", "Cat", "Producto Ñandú (2x1)!"])).toEqual({ path: ["Cat"], uncategorized: false });
  });
  it("G) etiquetas de categoría con acentos se preservan textualmente", () => {
    expect(normalizeSupplierTaxonomy(["Inicio", "Cosmética íntima", "Lubricantes y geles", "Gel"])).toEqual({
      path: ["Cosmética íntima", "Lubricantes y geles"], uncategorized: false,
    });
  });

  // §F — el recorte de la hoja de producto es POSICIONAL, nunca por coincidencia de texto.
  it("I) categoría cuyo nombre == producto SOBREVIVE (sólo se quita la hoja final)", () => {
    expect(normalizeSupplierTaxonomy(["Inicio", "Sex Toys", "Vibradores", "Vibradores"])).toEqual({
      path: ["Sex Toys", "Vibradores"], uncategorized: false,
    });
  });
  it("J) ['Inicio','A','A'] → ['A'] (la categoría 'A' sobrevive)", () => {
    expect(normalizeSupplierTaxonomy(["Inicio", "A", "A"])).toEqual({ path: ["A"], uncategorized: false });
  });
  it("nodo NO terminal con texto == producto NO se elimina", () => {
    // 'Vibradores' aparece en posición no-terminal (idx 1) y terminal (idx 3). Sólo la hoja final se quita.
    expect(normalizeSupplierTaxonomy(["Inicio", "Vibradores", "Sub", "Vibradores"])).toEqual({
      path: ["Vibradores", "Sub"], uncategorized: false,
    });
  });
  it("separadores y whitespace se descartan; raíz sólo se quita en posición 0", () => {
    expect(normalizeSupplierTaxonomy(["Inicio", " > ", "A", "  ", "Producto"])).toEqual({ path: ["A"], uncategorized: false });
  });
  it("UNCATEGORIZED != NOT_OBSERVED (contrato §12)", () => {
    const uncat = normalizeSupplierTaxonomy(["Inicio", "Productos", "X"]);
    const notObs = normalizeSupplierTaxonomy(null);
    expect(uncat).toEqual({ path: [], uncategorized: true });
    expect(notObs).toBeNull();
    expect(uncat).not.toEqual(notObs);
  });
});

describe("C1 · §H wiring: SKU hermanos de una ficha comparten la misma taxonomía (product-level)", () => {
  const ctxBase = {
    sourcePageIndex: 0,
    productId: 200,
    productName: "Prod Two",
    productUrl: "https://x/productos/prod-two/",
    domLabels: [] as (string | null)[],
    capturedAt: "2020-01-01T00:00:00.000Z",
  };
  it("dos variantes (SKU distintos, misma ficha=sourcePageIndex) → misma supplierTaxonomy; category null", () => {
    const bc = ["Inicio", "Sex Toys", "Vibradores", "Prod Two"];
    const rows: TnReducedRow[] = [
      mapLsVariantToReducedRow({ id: 2001, product_id: 200, sku: "BBB-1", price_number: 2000 }, { ...ctxBase, sourceVariantIndex: 0 }) as unknown as TnReducedRow,
      mapLsVariantToReducedRow({ id: 2002, product_id: 200, sku: "BBB-2", price_number: 2000 }, { ...ctxBase, sourceVariantIndex: 1 }) as unknown as TnReducedRow,
    ];
    const { products } = groupSkuFirst(rows, new Map([[0, bc]]));
    expect(products.length).toBe(2);
    const expected = { path: ["Sex Toys", "Vibradores"], uncategorized: false };
    for (const p of products) {
      expect(p.supplierTaxonomy).toEqual(expected);
      expect(p.category).toBeNull(); // legacy intacto
    }
  });
  it("sin mapa de breadcrumb → supplierTaxonomy null (NOT_OBSERVED) y category sigue null", () => {
    const rows: TnReducedRow[] = [
      mapLsVariantToReducedRow({ id: 9001, product_id: 900, sku: "ZZZ-1", price_number: 500 }, { ...ctxBase, sourceVariantIndex: 0 }) as unknown as TnReducedRow,
    ];
    const { products } = groupSkuFirst(rows); // sin 2º argumento
    expect(products[0].supplierTaxonomy ?? null).toBeNull();
    expect(products[0].category).toBeNull();
  });
});

// ── helper local para construir filas con sourcePageIndex arbitrario (no altera el extractor) ──
const mkRow = (pageIdx: number, pid: number, sku: string, vid: number, price = 1000): TnReducedRow =>
  mapLsVariantToReducedRow(
    { id: vid, product_id: pid, sku, price_number: price },
    { sourcePageIndex: pageIdx, sourceVariantIndex: vid, productId: pid, productName: "P" + pid, productUrl: "https://x/p/" + pid, domLabels: [], capturedAt: "2020-01-01T00:00:00.000Z" },
  ) as unknown as TnReducedRow;

describe("C1-R2 §2 · asociación por sourcePageIndex (sin fuga cruzada entre fichas)", () => {
  it("páginas NO contiguas (0,2,5): cada SKU recibe la taxonomía de SU ficha; página sin breadcrumb → null", () => {
    const rows: TnReducedRow[] = [
      mkRow(0, 100, "A-1", 1), mkRow(0, 100, "A-2", 2), // ficha A (2 SKU hermanos)
      mkRow(2, 200, "B-1", 3),                           // ficha B (1 SKU)
      mkRow(5, 300, "C-1", 4), mkRow(5, 300, "C-2", 5), // ficha C (2 SKU) — sin breadcrumb
    ];
    const map = new Map<number, (string | null)[] | null>([
      [0, ["Inicio", "A", "A prod"]],
      [2, ["Inicio", "B", "B prod"]],
      // 5 deliberadamente AUSENTE → NOT_OBSERVED
    ]);
    const { products } = groupSkuFirst(rows, map);
    const bySku = new Map(products.map((p) => [p.sku, p.supplierTaxonomy ?? null]));
    expect(bySku.get("A-1")).toEqual({ path: ["A"], uncategorized: false });
    expect(bySku.get("A-2")).toEqual({ path: ["A"], uncategorized: false });
    expect(bySku.get("B-1")).toEqual({ path: ["B"], uncategorized: false });
    expect(bySku.get("C-1")).toBeNull();
    expect(bySku.get("C-2")).toBeNull();
    // CROSS_PAGE_TAXONOMY_LEAKAGE = 0: ningún SKU de A/B/C recibe la ruta de otra ficha.
    const leak = products.filter((p) => {
      const t = p.supplierTaxonomy;
      if (p.sku?.startsWith("A")) return !t || t.path[0] !== "A";
      if (p.sku?.startsWith("B")) return !t || t.path[0] !== "B";
      if (p.sku?.startsWith("C")) return t !== null;
      return true;
    });
    expect(leak.length).toBe(0);
  });
});

describe("C1-R2 §3.A · failure-safety: la observación NUNCA rompe la captura de precio/SKU", () => {
  // CASE A/D — sin breadcrumb (elemento ausente / selector null) → mapa da null → supplierTaxonomy null,
  // precio/SKU intactos.
  it("CASE A/D · breadcrumb ausente → taxonomy null; wholesalePrice y sku preservados", () => {
    const rows = [mkRow(0, 1, "PRC-1", 1, 7777)];
    const { products } = groupSkuFirst(rows, new Map([[0, null]]));
    expect(products[0].supplierTaxonomy ?? null).toBeNull();
    expect(products[0].wholesalePrice).toBe(7777);
    expect(products[0].sku).toBe("PRC-1");
    expect(products[0].category).toBeNull();
  });
  // CASE B — contenedor presente pero vacío → [] → NOT_OBSERVED (null), NO uncategorized.
  it("CASE B · breadcrumb vacío ([]) → NOT_OBSERVED (null), NO uncategorized", () => {
    expect(normalizeSupplierTaxonomy([])).toBeNull();
    const { products } = groupSkuFirst([mkRow(0, 1, "EMP-1", 1)], new Map([[0, []]]));
    expect(products[0].supplierTaxonomy ?? null).toBeNull();
    expect(products[0].wholesalePrice).toBe(1000);
  });
  // CASE C — un solo nodo → NOT_OBSERVED, no lanza.
  it("CASE C · breadcrumb de un solo nodo ['Inicio'] → null, no lanza", () => {
    expect(() => normalizeSupplierTaxonomy(["Inicio"])).not.toThrow();
    expect(normalizeSupplierTaxonomy(["Inicio"])).toBeNull();
  });
  // CASE E — el normalizador es TOTAL: entradas adversariales nunca lanzan (equivalente a nivel de
  // helper del contrato de captura, cuya lectura DOM está envuelta en try/catch → breadcrumb=null).
  it("CASE E · normalizador total: entradas adversariales no lanzan", () => {
    const adversarial: any[] = [
      [123, {}, null, undefined, "Inicio", "Cat", "Prod"],
      [null, null],
      ["Inicio", "  ", ">", "/", "Prod"],
      Array(1000).fill("x"),
    ];
    for (const input of adversarial) {
      expect(() => normalizeSupplierTaxonomy(input)).not.toThrow();
    }
  });
});

describe("C1-R2 §6.A · normalización Unicode NFC (sin case-fold ni strip de acentos)", () => {
  it("NFC == NFD: la misma etiqueta en ambas codificaciones da la MISMA taxonomía", () => {
    const nfc = "Cosmética íntima".normalize("NFC");
    const nfd = "Cosmética íntima".normalize("NFD");
    expect(nfc).not.toBe(nfd); // sanity: difieren como strings crudos
    const a = normalizeSupplierTaxonomy(["Inicio", nfc, "Gel"]);
    const b = normalizeSupplierTaxonomy(["Inicio", nfd, "Gel"]);
    expect(a).toEqual(b); // NFC_NFD_EQUIVALENCE
    expect(a).toEqual({ path: ["Cosmética íntima".normalize("NFC")], uncategorized: false });
  });
  it("preserva ortografía visible: mayúsculas acentuadas (ELÁSTICO) y sin case-fold", () => {
    const r = normalizeSupplierTaxonomy(["Inicio", "ELÁSTICO", "Arnés", "Corpiño"]);
    expect(r).toEqual({ path: ["ELÁSTICO", "Arnés"], uncategorized: false });
    // sin lowercase, sin quitar acentos:
    expect(r!.path[0]).toBe("ELÁSTICO");
    expect(r!.path[1]).toBe("Arnés");
  });
});
