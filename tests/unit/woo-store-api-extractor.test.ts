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

// ── 7. RETRY con backoff ante 202/429/503 ────────────────────────────────────────
//
// Harness SECUENCIAL: varía la response por CONTEO DE LLAMADA a la MISMA url (el
// retry re-fetchea la misma url). Las responses transitorias (202/429/503) sirven
// un producto SENTINELA reconocible: si apareciera en el resultado, probaría que el
// extractor llamó .json()/collect sobre una response que no era 200. El body real
// se sirve solo en las responses 200. El sleep fake registra los ms y resuelve ya.

// SENTINELA: producto válido (pasaría los filtros si se colectara) → sku "999999".
const SENTINEL: WooProduct = {
  id: 999999,
  name: "SENTINELA-TRANSITORIO",
  prices: { price: "1", currency_minor_unit: 0 },
};
const SENTINEL_SKU = "999999";

const urlForPage = (page: number) =>
  `${BASE}/wp-json/wc/store/v1/products?per_page=100&page=${page}`;

interface PageSeq {
  statuses: number[]; // status por nº de llamada a esa url (clamp al último)
  body: WooProduct[]; // body servido en las responses 200
}

// Construye fetchFn + sleep fake. pageSeqs[i] = config de la página i+1.
function makeSeqFetch(pageSeqs: PageSeq[], totalPages?: number) {
  const calls: string[] = [];
  const callCount = new Map<string, number>();
  const sleeps: number[] = [];
  const tp = totalPages ?? pageSeqs.length;

  const fetchFn: FetchFn = async (url: string) => {
    calls.push(url);
    const m = url.match(/[?&]page=(\d+)/);
    const page = m ? parseInt(m[1], 10) : 1;
    const n = callCount.get(url) ?? 0;
    callCount.set(url, n + 1);
    const seq = pageSeqs[page - 1];
    const status = seq.statuses[Math.min(n, seq.statuses.length - 1)];
    const body = status === 200 ? seq.body : [SENTINEL];
    return {
      status,
      headers: {
        get: (h: string) =>
          h.toLowerCase() === "x-wp-totalpages" ? String(tp) : null,
      },
      json: async () => body,
    };
  };

  const sleep = async (ms: number) => {
    sleeps.push(ms);
  };

  const fetchesFor = (page: number) =>
    calls.filter((u) => u === urlForPage(page)).length;

  return { fetchFn, sleep, sleeps, fetchesFor };
}

const runWithSeq = (h: ReturnType<typeof makeSeqFetch>) =>
  extractWooStoreApi({ baseUrl: BASE, skuPrefix: "ELY-", fetchFn: h.fetchFn, sleep: h.sleep });

describe("extractWooStoreApi — retry con backoff", () => {
  it("1. [200] → 1 fetch, 0 sleeps, retorna productos", async () => {
    const h = makeSeqFetch([{ statuses: [200], body: [byId(31385)] }]);
    const res = await runWithSeq(h);
    expect(h.fetchesFor(1)).toBe(1);
    expect(h.sleeps).toEqual([]);
    expect(skus(res)).toContain("31385");
  });

  it("2. [202,200] → 2 fetches, sleep [500], éxito, sentinela NO aparece, WARN logueado", async () => {
    const h = makeSeqFetch([{ statuses: [202, 200], body: [byId(31385)] }]);
    const logs: { level: string; meta?: Record<string, unknown> }[] = [];
    const res = await extractWooStoreApi({
      baseUrl: BASE,
      skuPrefix: "ELY-",
      fetchFn: h.fetchFn,
      sleep: h.sleep,
      onLog: (level, _msg, meta) => {
        logs.push({ level, meta });
      },
    });
    expect(h.fetchesFor(1)).toBe(2);
    expect(h.sleeps).toEqual([500]);
    expect(skus(res)).toContain("31385");
    expect(skus(res)).not.toContain(SENTINEL_SKU);
    // onLog: al menos un WARN con metadata { status, page, attempt } (sin depender del texto).
    const warns = logs.filter((l) => l.level === "WARN");
    expect(warns.length).toBeGreaterThanOrEqual(1);
    const m = warns.find((w) => w.meta != null)?.meta ?? {};
    expect(m).toHaveProperty("status", 202);
    expect(m).toHaveProperty("page", 1);
    expect(m).toHaveProperty("attempt");
  });

  it("3. [202,202,200] → 3 fetches, sleep [500,1500], éxito, sentinela NO aparece", async () => {
    const h = makeSeqFetch([{ statuses: [202, 202, 200], body: [byId(31385)] }]);
    const res = await runWithSeq(h);
    expect(h.fetchesFor(1)).toBe(3);
    expect(h.sleeps).toEqual([500, 1500]);
    expect(skus(res)).toContain("31385");
    expect(skus(res)).not.toContain(SENTINEL_SKU);
  });

  it("4. [202,202,202,202] → 4 fetches, sleep [500,1500,3000], THROW, sin lista parcial", async () => {
    const h = makeSeqFetch([{ statuses: [202, 202, 202, 202], body: [byId(31385)] }]);
    await expect(runWithSeq(h)).rejects.toThrow();
    expect(h.fetchesFor(1)).toBe(4);
    expect(h.sleeps).toEqual([500, 1500, 3000]);
  });

  it("5. [429,200] → 2 fetches, sleep [500], éxito (429 reintentable)", async () => {
    const h = makeSeqFetch([{ statuses: [429, 200], body: [byId(31385)] }]);
    const res = await runWithSeq(h);
    expect(h.fetchesFor(1)).toBe(2);
    expect(h.sleeps).toEqual([500]);
    expect(skus(res)).toContain("31385");
    expect(skus(res)).not.toContain(SENTINEL_SKU);
  });

  it("6. [503,200] → 2 fetches, sleep [500], éxito (503 reintentable)", async () => {
    const h = makeSeqFetch([{ statuses: [503, 200], body: [byId(31385)] }]);
    const res = await runWithSeq(h);
    expect(h.fetchesFor(1)).toBe(2);
    expect(h.sleeps).toEqual([500]);
    expect(skus(res)).toContain("31385");
    expect(skus(res)).not.toContain(SENTINEL_SKU);
  });

  it("7. [500] → 1 fetch, 0 sleeps, THROW inmediato (500 TERMINAL, no reintenta)", async () => {
    const h = makeSeqFetch([{ statuses: [500], body: [byId(31385)] }]);
    await expect(runWithSeq(h)).rejects.toThrow();
    expect(h.fetchesFor(1)).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it("8. [404] → 1 fetch, 0 sleeps, THROW inmediato", async () => {
    const h = makeSeqFetch([{ statuses: [404], body: [byId(31385)] }]);
    await expect(runWithSeq(h)).rejects.toThrow();
    expect(h.fetchesFor(1)).toBe(1);
    expect(h.sleeps).toEqual([]);
  });

  it("9. Loop: pág1 [200], pág2 [202,200] → pág2 2 fetches, sleep [500], productos de ambas", async () => {
    const h = makeSeqFetch(
      [
        { statuses: [200], body: [byId(31385)] },
        { statuses: [202, 200], body: [byId(40004)] },
      ],
      2
    );
    const res = await runWithSeq(h);
    expect(h.fetchesFor(1)).toBe(1);
    expect(h.fetchesFor(2)).toBe(2);
    expect(h.sleeps).toEqual([500]);
    expect(skus(res)).toEqual(expect.arrayContaining(["31385", "40004"]));
    expect(skus(res)).not.toContain(SENTINEL_SKU);
  });

  it("10. Per-página: pág1 [202,200], pág2 [202,200] → sleeps [500,500] (presupuesto propio)", async () => {
    const h = makeSeqFetch(
      [
        { statuses: [202, 200], body: [byId(31385)] },
        { statuses: [202, 200], body: [byId(40004)] },
      ],
      2
    );
    const res = await runWithSeq(h);
    expect(h.fetchesFor(1)).toBe(2);
    expect(h.fetchesFor(2)).toBe(2);
    expect(h.sleeps).toEqual([500, 500]); // cada página resetea su backoff, NO [500,1500]
    expect(skus(res)).toEqual(expect.arrayContaining(["31385", "40004"]));
    expect(skus(res)).not.toContain(SENTINEL_SKU);
  });
});
