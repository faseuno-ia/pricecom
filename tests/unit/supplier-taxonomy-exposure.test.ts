// C2-MINI-A · CLASE: DEFECT_RED · mapper + exposición (Excel)
//
// Contrato NUEVO. Deben fallar ANTES de implementar.
//
// Los dos contratos de Excel se afirman sobre el WORKBOOK PRODUCIDO, igual que la caracterización
// A1: si la columna nueva se intercalara en vez de agregarse al final, el grep no lo vería y el
// cliente sí.
//
// 100% offline: sin DB, sin red.

import { describe, it, expect, vi } from "vitest";
import ExcelJS from "exceljs";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const USER_ID = "cmp504wd40000t25nssc377rw";
const PROVIDER_ID = "cmp3hop7700003mhu29jk9kxd";
const T1 = new Date("2026-08-24T10:00:00.000Z");

/** Fila del catálogo que devuelve el stub. Mutable para variar el estado de taxonomía por caso. */
const catalogRow: Record<string, unknown> = {
  id: "cp-1",
  userId: USER_ID,
  providerId: PROVIDER_ID,
  sku: "SKU-1",
  supplierName: "Producto uno",
  commercialTitle: null,
  supplierCategory: "Categoría legacy",
  assignedCategory: null,
  assignedCategoryId: null,
  imageUrl: "https://img.example.test/1.jpg",
  images: [],
  publications: [],
  wholesalePrice: 100,
  manualMargin: null,
  finalPrice: 150,
  provider: { listDiscountPercent: null },
  supplierTaxonomyPath: [],
  supplierTaxonomyObservedAt: null,
  supplierTaxonomyUncategorized: null,
};

vi.mock("@/lib/auth", () => ({
  requireSession: async () => ({ user: { id: USER_ID } }),
  getSession: async () => ({ user: { id: USER_ID } }),
}));

vi.mock("@/lib/db/client", () => {
  const client = {
    catalogProduct: {
      count: async () => 1,
      findMany: async () => [catalogRow],
    },
    pricingRule: { findMany: async () => [] },
  };
  return { prisma: client, default: client };
});

function setTaxonomy(path: string[], observedAt: Date | null, uncategorized: boolean | null) {
  catalogRow.supplierTaxonomyPath = path;
  catalogRow.supplierTaxonomyObservedAt = observedAt;
  catalogRow.supplierTaxonomyUncategorized = uncategorized;
}

async function sheetOf(buffer: ArrayBuffer | Buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as never);
  return wb.worksheets[0];
}

function rowValues(sheet: ExcelJS.Worksheet, n: number): string[] {
  const values = sheet.getRow(n).values as unknown[];
  return values.slice(1).map((v) => (v === undefined || v === null ? "" : String(v)));
}

/** Corre el export de catálogo y devuelve headers + primera fila de datos. */
async function catalogExport() {
  const { POST } = await import("@/app/api/catalog/export/route");
  const res = await POST({ json: async () => ({ catalogProductIds: ["cp-1"] }) } as never);
  const sheet = await sheetOf(await res.arrayBuffer());
  return { headers: rowValues(sheet, 1), first: rowValues(sheet, 2) };
}

const COLUMNA_NUEVA = "Categoría proveedor (ruta)";

describe("C2-MINI-A · DEFECT_RED · mapper", () => {
  it("mapper_carries_supplier_taxonomy", async () => {
    const { mapScrapedToExtractedProductInput } = await import(
      "@/lib/scraper/extracted-product-input"
    );
    const base = {
      sku: "SKU-1",
      name: "Producto",
      description: null,
      wholesalePrice: 1,
      oldPrice: null,
      stock: null,
      category: null,
      brand: null,
      productUrl: null,
      imageUrl: null,
      rawData: {},
    };
    const call = (supplierTaxonomy: unknown) =>
      (mapScrapedToExtractedProductInput as unknown as (
        p: unknown,
        j: string,
        pr: string,
        at: Date,
      ) => Record<string, unknown>)({ ...base, supplierTaxonomy }, "job-1", PROVIDER_ID, T1);

    // 1 · no observado — ni null ni undefined producen observación
    for (const ausente of [null, undefined]) {
      const out = call(ausente);
      expect(out.supplierTaxonomyPath).toEqual([]);
      expect(out.supplierTaxonomyObservedAt).toBeNull();
      expect(out.supplierTaxonomyUncategorized).toBeNull();
    }

    // 2 · uncategorized
    const unc = call({ path: [], uncategorized: true });
    expect(unc.supplierTaxonomyPath).toEqual([]);
    expect(unc.supplierTaxonomyObservedAt).toEqual(T1);
    expect(unc.supplierTaxonomyUncategorized).toBe(true);

    // 3 · breadcrumb — path exacto, sin tocar orden, acentos ni case (C1 gobierna esa semántica)
    const bc = call({ path: ["Niños", "Autos a Batería", "12V"], uncategorized: false });
    expect(bc.supplierTaxonomyPath).toEqual(["Niños", "Autos a Batería", "12V"]);
    expect(bc.supplierTaxonomyObservedAt).toEqual(T1);
    expect(bc.supplierTaxonomyUncategorized).toBe(false);
  });

  it("mapper_uses_one_observed_at_per_attempt", async () => {
    const { mapScrapedToExtractedProductInput } = await import(
      "@/lib/scraper/extracted-product-input"
    );
    const p = {
      sku: "S",
      name: "n",
      description: null,
      wholesalePrice: null,
      oldPrice: null,
      stock: null,
      category: null,
      brand: null,
      productUrl: null,
      imageUrl: null,
      rawData: {},
      supplierTaxonomy: { path: ["A"], uncategorized: false },
    };
    const fn = mapScrapedToExtractedProductInput as unknown as (
      x: unknown,
      j: string,
      pr: string,
      at: Date,
    ) => Record<string, unknown>;

    // Mil productos del mismo attempt comparten UN timestamp: no `products.map(() => new Date())`.
    const out = Array.from({ length: 3 }, () => fn(p, "job-1", PROVIDER_ID, T1));
    const stamps = new Set(out.map((o) => (o.supplierTaxonomyObservedAt as Date).getTime()));
    expect(stamps.size).toBe(1);
    expect([...stamps][0]).toBe(T1.getTime());
  });
});

describe("C2-MINI-A · DEFECT_RED · Excel de catálogo", () => {
  it("supplier_taxonomy_column_is_appended_not_inserted", async () => {
    setTaxonomy([], null, null);
    const { headers } = await catalogExport();

    // Las seis previas conservan nombre Y posición…
    expect(headers.slice(0, 6)).toEqual([
      "SKU comercial",
      "SKU Proveedor",
      "Descripción",
      "Precio",
      "Categoría",
      "Imagen",
    ]);
    // …y la nueva es la ÚLTIMA.
    expect(headers).toHaveLength(7);
    expect(headers[6]).toBe(COLUMNA_NUEVA);
  });

  it("supplier_taxonomy_column_renders_three_states", async () => {
    // 1 · no observado → cadena vacía (NO "Sin categoría": son estados distintos)
    setTaxonomy([], null, null);
    let out = await catalogExport();
    expect(out.first[6]).toBe("");

    // 2 · observado sin categoría
    setTaxonomy([], T1, true);
    out = await catalogExport();
    expect(out.first[6]).toBe("Sin categoría");

    // 3 · breadcrumb
    setTaxonomy(["A", "B", "C"], T1, false);
    out = await catalogExport();
    expect(out.first[6]).toBe("A > B > C");
  });

})

describe("C2-MINI-A · DEFECT_RED · Excel de extracción", () => {
  const LEGACY_14 = [
    "SKU",
    "Nombre",
    "Descripción",
    "Precio Mayorista",
    "Precio Anterior",
    "Stock",
    "Categoría",
    "Marca",
    "URL Producto",
    "URL Imagen",
    "Proveedor",
    "Fecha Extracción",
    "Estado",
    "Observaciones",
  ];

  async function extractionExcel(row: Record<string, unknown>) {
    const { generateExcel } = await import("@/lib/excel/generator");
    const { buffer } = await generateExcel(
      [row as never],
      { id: PROVIDER_ID, name: "Proveedor" } as never,
      "job-1",
    );
    const sheet = await sheetOf(buffer);
    return { headers: rowValues(sheet, 1), first: rowValues(sheet, 2) };
  }

  const snapshotRow = (over: Record<string, unknown> = {}) => ({
    sku: "SKU-1",
    name: "Producto",
    description: null,
    wholesalePrice: null,
    oldPrice: null,
    stock: null,
    category: "Categoría legacy",
    brand: null,
    productUrl: null,
    imageUrl: null,
    extractedAt: T1,
    status: null,
    observations: null,
    supplierTaxonomyPath: [],
    supplierTaxonomyObservedAt: null,
    supplierTaxonomyUncategorized: null,
    ...over,
  });

  it("extraction_supplier_taxonomy_column_is_appended_not_inserted", async () => {
    const { headers } = await extractionExcel(snapshotRow());
    expect(headers.slice(0, 14)).toEqual(LEGACY_14);
    expect(headers).toHaveLength(15);
    expect(headers[14]).toBe(COLUMNA_NUEVA);
  });

  it("extraction_supplier_taxonomy_column_renders_three_states", async () => {
    let out = await extractionExcel(snapshotRow());
    expect(out.first[14]).toBe("");

    out = await extractionExcel(
      snapshotRow({ supplierTaxonomyObservedAt: T1, supplierTaxonomyUncategorized: true }),
    );
    expect(out.first[14]).toBe("Sin categoría");

    out = await extractionExcel(
      snapshotRow({
        supplierTaxonomyPath: ["A", "B", "C"],
        supplierTaxonomyObservedAt: T1,
        supplierTaxonomyUncategorized: false,
      }),
    );
    expect(out.first[14]).toBe("A > B > C");
  });
});
describe("C2-MINI-A · R-4 · el módulo de presentación es puro", () => {
  it("supplier_taxonomy_display_has_no_server_imports", () => {
    const src = readFileSync(
      resolve(process.cwd(), "lib/catalog/supplier-taxonomy-display.ts"),
      "utf8",
    );
    // Se cuenta sobre CÓDIGO: un comentario que nombre Prisma no es un import.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
      .join("\n");

    expect(code).not.toMatch(/^\s*import\s/m);
    for (const forbidden of ["@prisma/client", "event-log", "db/client", "worker/"]) {
      expect(code, "el módulo puro no puede depender de " + forbidden).not.toContain(forbidden);
    }

    // Control positivo: el escáner SÍ ve imports server-only en el writer, que los tiene.
    const writer = readFileSync(
      resolve(process.cwd(), "lib/catalog/supplier-taxonomy-observation.ts"),
      "utf8",
    );
    expect(writer).toContain("@prisma/client");
  });
});

