// C2-MINI-A · CLASE: A1 · CHARACTERIZATION
//
// Congela el comportamiento ACTUAL, ANTES de agregar la capacidad de taxonomía. Todos estos deben
// pasar VERDE contra el código de hoy; si se escribieran después del cambio no caracterizarían el
// contrato viejo, sólo congelarían el resultado nuevo.
//
// Los dos contratos de Excel se afirman leyendo el WORKBOOK PRODUCIDO, no el texto de la fuente:
// un `sheet.columns = [...]` puede reordenarse por un helper o un spread sin que el grep lo note.
//
// 100% offline: sin DB, sin red.

import { describe, it, expect, vi } from "vitest";
import ExcelJS from "exceljs";

const USER_ID = "cmp504wd40000t25nssc377rw";
const PROVIDER_ID = "cmp3hop7700003mhu29jk9kxd";
// El 4º argumento del mapper es nuevo; las aserciones sobre los 13 campos legacy no cambian.
const ATTEMPT_AT = new Date("2026-08-24T00:00:00.000Z");

vi.mock("@/lib/auth", () => ({
  requireSession: async () => ({ user: { id: USER_ID } }),
  getSession: async () => ({ user: { id: USER_ID } }),
}));

// Stub de Prisma hecho a mano (no el fake genérico): esta ruta usa count + findMany con include
// anidado, y un stub explícito hace visible exactamente qué necesita para producir el workbook.
vi.mock("@/lib/db/client", () => {
  const row = {
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
  };
  const client = {
    catalogProduct: {
      count: async () => 1,
      findMany: async () => [row],
    },
    pricingRule: { findMany: async () => [] },
  };
  return { prisma: client, default: client };
});

/** Lee la fila 1 del workbook producido. `values` de ExcelJS es 1-based: el índice 0 viene vacío. */
async function headersOf(buffer: ArrayBuffer | Buffer): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as never);
  const sheet = wb.worksheets[0];
  const values = sheet.getRow(1).values as unknown[];
  return values.slice(1).map((v) => String(v));
}

async function headersOfRow(buffer: ArrayBuffer | Buffer, n: number): Promise<string[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as never);
  const values = wb.worksheets[0].getRow(n).values as unknown[];
  return values.slice(1).map((v) => (v === undefined || v === null ? "" : String(v)));
}

async function postExport() {
  const { POST } = await import("@/app/api/catalog/export/route");
  return POST({ json: async () => ({ catalogProductIds: ["cp-1"] }) } as never);
}

describe("C2-MINI-A · A1 · CHARACTERIZATION", () => {
  // ── A1.1 · PRICE_ONLY ────────────────────────────────────────────────────────────

  it("price_only_allowlist_is_unchanged", async () => {
    const PRICE_KEYS = ["lastSeenAt", "latestExtractedProductId", "wholesalePrice"];

    // ── writer 2 · writePriceOnlyExplicit (cliente inyectable) ──
    const { writePriceOnlyExplicit } = await import("@/lib/catalog/price-only-partial-write");
    const seen2: Record<string, unknown>[] = [];
    await writePriceOnlyExplicit(
      {
        catalogProduct: {
          findMany: (async () => [{ id: "cp-1", sku: "SKU-1" }]) as never,
          update: (async (a: { data: Record<string, unknown> }) => {
            seen2.push(a.data);
            return {} as never;
          }) as never,
        },
      },
      {
        userId: USER_ID,
        providerId: PROVIDER_ID,
        entries: [{ sku: "SKU-1", newPrice: 123, extractedProductId: "ep-1" }],
        lastSeenAt: new Date("2026-08-24T00:00:00.000Z"),
      },
    );
    expect(seen2).toHaveLength(1);
    expect(Object.keys(seen2[0]).sort()).toEqual(PRICE_KEYS);

    // ── writer 1 · upsertCatalogProducts, rama PRICE_ONLY ──
    const { upsertCatalogProducts } = await import("@/lib/catalog/upsert-catalog-products");
    const seen1: Record<string, unknown>[] = [];
    const stub = {
      extractionJob: {
        findUnique: async () => ({
          id: "job-1",
          userId: USER_ID,
          providerId: PROVIDER_ID,
          products: [{ id: "ep-1", sku: "SKU-1", wholesalePrice: 123 }],
        }),
      },
      providerScraperConfig: {
        findUnique: async () => ({ catalogWriteMode: "PRICE_ONLY" }),
      },
      // La función resuelve pricing y store ANTES de ramificar a PRICE_ONLY; vacíos alcanzan.
      pricingRule: { findMany: async () => [] },
      store: { findFirst: async () => null, findUnique: async () => null, findMany: async () => [] },
      catalogProduct: {
        findMany: async () => [{ id: "cp-1", sku: "SKU-1" }],
        update: async (a: { data: Record<string, unknown> }) => {
          seen1.push(a.data);
          return {};
        },
      },
    };
    await upsertCatalogProducts("job-1", stub as never);
    expect(seen1).toHaveLength(1);
    expect(Object.keys(seen1[0]).sort()).toEqual(PRICE_KEYS);
  });

  // ── A1.2 · Excel de catálogo ─────────────────────────────────────────────────────

  it("catalog_export_column_contract_is_frozen", async () => {
    const { POST } = await import("@/app/api/catalog/export/route");
    // bodySchema exige catalogProductIds o filters; el stub devuelve la misma fila igual.
    const res = await POST({ json: async () => ({ catalogProductIds: ["cp-1"] }) } as never);

    expect(res.status).toBe(200);
    const headers = await headersOf(await res.arrayBuffer());
    expect(headers).toEqual([
      "SKU comercial",
      "SKU Proveedor",
      "Descripción",
      "Precio",
      "Categoría",
      "Imagen",
      // PASO 2 · agregada por C2-MINI-A. Las seis previas conservan nombre Y posición: esta
      // aserción sólo vale porque la versión de 6 columnas pasó VERDE antes del cambio.
      "Categoría proveedor (ruta)",
    ]);
    expect(headers).toHaveLength(7);

    // La columna legacy "Categoría" conserva posición Y valor. Reclasificada desde DEFECT_RED:
    // pasa antes del cambio porque no prueba capacidad nueva — vigila que la vieja no se dañe.
    const first = (await headersOfRow(await (await postExport()).arrayBuffer(), 2));
    expect(headers[4]).toBe("Categoría");
    expect(first[4]).toBe("Categoría legacy");
  });

  // ── A1.3 · Excel de extracción ───────────────────────────────────────────────────

  it("extraction_excel_column_contract_is_frozen", async () => {
    const { generateExcel } = await import("@/lib/excel/generator");
    const { buffer } = await generateExcel(
      [],
      { id: PROVIDER_ID, name: "Proveedor" } as never,
      "job-1",
    );

    const headers = await headersOf(buffer);
    expect(headers).toEqual([
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
      "Categoría proveedor (ruta)", // PASO 2 · agregada al FINAL por C2-MINI-A
    ]);
    expect(headers).toHaveLength(15);
  });

  // ── A1.4 · Mapper ────────────────────────────────────────────────────────────────

  it("mapper_output_shape_is_unchanged_for_legacy_fields", async () => {
    const { mapScrapedToExtractedProductInput } = await import(
      "@/lib/scraper/extracted-product-input"
    );
    const scraped = {
      sku: "SKU-1",
      name: "Producto uno",
      description: "desc",
      wholesalePrice: 100,
      oldPrice: 120,
      stock: "10",
      category: "cat",
      brand: "marca",
      productUrl: "https://p.example.test/1",
      imageUrl: "https://img.example.test/1.jpg",
      rawData: { variants: [{ sku: "SKU-1" }] },
    };
    const out = mapScrapedToExtractedProductInput(scraped as never, "job-1", PROVIDER_ID, ATTEMPT_AT);

    // Valores exactos de los 13 campos históricos.
    expect(out.jobId).toBe("job-1");
    expect(out.providerId).toBe(PROVIDER_ID);
    expect(out.sku).toBe("SKU-1");
    expect(out.name).toBe("Producto uno");
    expect(out.description).toBe("desc");
    expect(out.wholesalePrice).toBe(100);
    expect(out.oldPrice).toBe(120);
    expect(out.stock).toBe("10");
    expect(out.category).toBe("cat");
    expect(out.brand).toBe("marca");
    expect(out.productUrl).toBe("https://p.example.test/1");
    expect(out.imageUrl).toBe("https://img.example.test/1.jpg");
    expect(out.rawData).toEqual({ variants: [{ sku: "SKU-1" }] });

    // El default histórico del nombre vacío se conserva.
    const sinNombre = mapScrapedToExtractedProductInput(
      { ...scraped, name: "" } as never,
      "job-1",
      PROVIDER_ID,
      ATTEMPT_AT,
    );
    expect(sinNombre.name).toBe("Sin nombre");
  });
});
