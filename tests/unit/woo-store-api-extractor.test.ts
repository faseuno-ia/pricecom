// GATE 2-T — Tests primero (TDD) del extractor WooCommerce Store API.
//
// ESTADO ESPERADO: ROJO por "not implemented" (el extractor es stub; la lógica
// real es Gate 2-I). NO toca red ni DB: el `fetchFn` se inyecta y sirve fixtures.
//
// Contrato verificado: el extractor devuelve ScrapedProduct[] (mismo que
// ScraperService.run()), con paginación por X-WP-TotalPages, filtros de
// exclusión, mapeo de campos (incl. precio por currency_minor_unit) y skuPrefix.

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { extractWooStoreApi, type FetchFn } from "@/lib/extractors/woo-store-api-extractor";

type WooProduct = Record<string, unknown>;

function loadFixture(name: string): WooProduct[] {
  const p = path.resolve(process.cwd(), "tests/fixtures/woo-store-api", name);
  return JSON.parse(fs.readFileSync(p, "utf8")) as WooProduct[];
}
const PAGE1 = loadFixture("page1.json");
const PAGE2 = loadFixture("page2.json");
const byId = (id: number) =>
  [...PAGE1, ...PAGE2].find((x) => (x as { id: number }).id === id)!;

const BASE = "https://shop.example.test";

// Fake fetch: lee ?page=N de la URL, sirve la página correspondiente, y expone
// X-WP-TotalPages = cantidad de páginas. Registra las URLs llamadas.
function makeFetch(pages: WooProduct[][]) {
  const calls: string[] = [];
  const fetchFn: FetchFn = async (url: string) => {
    calls.push(url);
    const m = url.match(/[?&]page=(\d+)/);
    const page = m ? parseInt(m[1], 10) : 1;
    const body = pages[page - 1] ?? [];
    return {
      status: 200,
      headers: {
        get: (h: string) =>
          h.toLowerCase() === "x-wp-totalpages" ? String(pages.length) : null,
      },
      json: async () => body,
    };
  };
  return { fetchFn, calls };
}

const skus = (rows: { sku: string | null }[]) => rows.map((r) => r.sku);

// ── 1. PAGINACIÓN ──────────────────────────────────────────────────────────────
describe("extractWooStoreApi — paginación", () => {
  it("lee X-WP-TotalPages y pagina page=1..N con per_page=100", async () => {
    const { fetchFn, calls } = makeFetch([PAGE1, PAGE2]);
    const res = await extractWooStoreApi({ baseUrl: BASE, skuPrefix: "ELY-", fetchFn });

    // Válidos: 31385 (p1) + 40004, 40005, 40006 (p2) = 4 (los excluidos se filtran).
    expect(res).toHaveLength(4);
    // sku = id pelado del proveedor (sin prefijo); el prefijo se aplica al publicar.
    expect(skus(res)).toEqual(
      expect.arrayContaining(["31385", "40004", "40005", "40006"])
    );
    expect(calls).toHaveLength(2);
    expect(calls[0]).toMatch(/page=1/);
    expect(calls[0]).toMatch(/per_page=100/);
    expect(calls[1]).toMatch(/page=2/);
  });

  it("una sola página cuando X-WP-TotalPages=1 → un solo fetch", async () => {
    const { fetchFn, calls } = makeFetch([[byId(31385)]]);
    const res = await extractWooStoreApi({ baseUrl: BASE, skuPrefix: "ELY-", fetchFn });
    expect(res).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });
});

// ── 2. FILTROS de exclusión ─────────────────────────────────────────────────────
describe("extractWooStoreApi — filtros de exclusión", () => {
  it("excluye is_purchasable === false (no comprables)", async () => {
    const { fetchFn } = makeFetch([PAGE1]); // 40001 no comprable
    const res = await extractWooStoreApi({ baseUrl: BASE, skuPrefix: "ELY-", fetchFn });
    expect(skus(res)).not.toContain("40001");
  });

  it("excluye type === 'woosb' (bundles/combos)", async () => {
    const { fetchFn } = makeFetch([PAGE1]); // 40002 woosb
    const res = await extractWooStoreApi({ baseUrl: BASE, skuPrefix: "ELY-", fetchFn });
    expect(skus(res)).not.toContain("40002");
  });

  it("excluye variable con prices.price_range != null", async () => {
    const { fetchFn } = makeFetch([PAGE2]); // 40003 variable c/ rango
    const res = await extractWooStoreApi({ baseUrl: BASE, skuPrefix: "ELY-", fetchFn });
    expect(skus(res)).not.toContain("40003");
  });

  it("INCLUYE variable sin price_range (válido)", async () => {
    const { fetchFn } = makeFetch([PAGE2]); // 40004 variable sin rango
    const res = await extractWooStoreApi({ baseUrl: BASE, skuPrefix: "ELY-", fetchFn });
    expect(skus(res)).toContain("40004");
  });
});

// ── 3. MAPEO de campos ───────────────────────────────────────────────────────────
describe("extractWooStoreApi — mapeo al contrato ScrapedProduct", () => {
  it("mapea un producto simple válido", async () => {
    const { fetchFn } = makeFetch([[byId(31385)]]);
    const [p] = await extractWooStoreApi({ baseUrl: BASE, skuPrefix: "ELY-", fetchFn });
    expect(p.sku).toBe("31385"); // id pelado; la API trae sku "" y se ignora; el prefijo se aplica al publicar
    expect(p.wholesalePrice).toBe(3500); // minor_unit 0 → /1, crudo sin descuento
    expect(p.name).toBe("AUTO DE FRICCIÓN SUPER RACER");
    expect(p.description).toBeNull(); // "" → null
    expect(p.imageUrl).toBe(
      "https://importadorahaote.com/wp-content/uploads/auto-racer.jpg"
    );
    expect(p.category).toBe("Autos a Fricción"); // ÚLTIMA del array (más específica)
    expect(p.productUrl).toBe(
      "https://importadorahaote.com/product/auto-friccion-super-racer/"
    );
    expect(p.stock).toBeNull(); // ignoramos is_in_stock
    expect(p.oldPrice).toBeNull();
    expect(p.brand).toBeNull();
    expect(p.rawData).toEqual(byId(31385)); // crudo, trazabilidad
  });
});

// ── 4. PRECIO por currency_minor_unit ────────────────────────────────────────────
describe("extractWooStoreApi — precio por currency_minor_unit", () => {
  it("minor_unit=0 → price tal cual (3500 → 3500)", async () => {
    const { fetchFn } = makeFetch([[byId(31385)]]);
    const [p] = await extractWooStoreApi({ baseUrl: BASE, skuPrefix: "ELY-", fetchFn });
    expect(p.wholesalePrice).toBe(3500);
  });

  it("minor_unit=2 → price / 100 (1590000 → 15900)", async () => {
    const { fetchFn } = makeFetch([[byId(40006)]]);
    const [p] = await extractWooStoreApi({ baseUrl: BASE, skuPrefix: "LEDM-", fetchFn });
    expect(p.wholesalePrice).toBe(15900);
  });
});

// ── 5. SKU = id pelado, INDEPENDIENTE del skuPrefix ──────────────────────────────
describe("extractWooStoreApi — sku = id pelado (el prefijo NO afecta el sku)", () => {
  it("el sku es el id del proveedor sin prefijo, cualquiera sea el skuPrefix", async () => {
    // Mismo id (31385) con dos prefijos distintos → el sku NO cambia: es "31385".
    // El skuPrefix se aplica recién al publicar (SKU comercial), no acá.
    const { fetchFn: f1 } = makeFetch([[byId(31385)]]);
    const [a] = await extractWooStoreApi({ baseUrl: BASE, skuPrefix: "ELY-", fetchFn: f1 });
    expect(a.sku).toBe("31385");

    const { fetchFn: f2 } = makeFetch([[byId(31385)]]);
    const [b] = await extractWooStoreApi({ baseUrl: BASE, skuPrefix: "LEDM-", fetchFn: f2 });
    expect(b.sku).toBe("31385");
  });
});

// ── 6. Casos borde ───────────────────────────────────────────────────────────────
describe("extractWooStoreApi — casos borde", () => {
  it("sin imágenes → imageUrl null; sin categorías → category null", async () => {
    const { fetchFn } = makeFetch([[byId(40005)]]);
    const [p] = await extractWooStoreApi({ baseUrl: BASE, skuPrefix: "ELY-", fetchFn });
    expect(p.imageUrl).toBeNull();
    expect(p.category).toBeNull();
  });
});
