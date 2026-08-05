// GATE A2 — walker vivo SKU-first (dos fases), sin red/sitio/Playwright.
// Toda la I/O está inyectada (fakes): discovery de listados, navegación a
// fichas, re-login, captura window.LS, logging, progreso y cancelación.
import { describe, it, expect } from "vitest";
import {
  collectProductUrlsFromListings,
  mapProductPagePayloadToReducedRows,
  captureProductRows,
  runSkuFirstWalk,
  type WalkerDeps,
  type RawLsPagePayload,
} from "@/lib/scraper/tiendanube-walker";

const FIXED_NOW = "2026-01-01T00:00:00.000Z";

function payloadFor(url: string, variants?: Record<string, unknown>[]): RawLsPagePayload {
  return {
    productName: "Prod " + url,
    productUrl: url,
    domLabels: ["Color"],
    variants: variants ?? [
      {
        id: "1", product_id: "100", sku: "SKU-" + url, option0: "X",
        price_number: 100, price_number_raw: 10000, price_short: "$100,00", price_long: "$100,00 ARS",
        price_without_taxes: "$82,64", promotional_price_number: null,
        stock: null, available: true, image: 1, image_url: "//img/" + url + ".webp",
      },
    ],
  };
}

interface HarnessCfg {
  listings: string[][];
  maxListingPages?: number;
  maxProductRetries?: number;
  resolveUrl?: (href: string) => string | null;
  isCancelled?: () => boolean;
  redirectToLogin?: Set<string>; // urls que redirigen a login en el 1er navigate
  capture?: (url: string, attempt: number) => RawLsPagePayload; // override; puede throw
}

function makeHarness(cfg: HarnessCfg) {
  const calls = {
    extractListing: 0,
    goToNextListing: 0,
    navigate: [] as string[],
    reLogin: 0,
    captureLs: [] as string[],
    logs: [] as [string, string][],
    progress: [] as unknown[],
  };
  let listingPtr = 0;
  let currentUrl: string | null = null;
  let reLoggedIn = false;
  const captureAttempts: Record<string, number> = {};

  const deps: WalkerDeps = {
    maxListingPages: cfg.maxListingPages ?? 100,
    maxProductRetries: cfg.maxProductRetries ?? 2,
    now: () => FIXED_NOW,
    isCancelled: cfg.isCancelled ?? (() => false),
    resolveUrl: cfg.resolveUrl ?? ((h) => h),
    async extractListingProductUrls() {
      calls.extractListing++;
      return cfg.listings[listingPtr] ?? [];
    },
    async goToNextListing() {
      calls.goToNextListing++;
      if (listingPtr + 1 < cfg.listings.length) {
        listingPtr++;
        return true;
      }
      return false;
    },
    async navigateToProduct(url: string) {
      calls.navigate.push(url);
      currentUrl = url;
      const redirected = !!cfg.redirectToLogin?.has(url) && !reLoggedIn;
      return { redirectedToLogin: redirected };
    },
    async reLogin() {
      calls.reLogin++;
      reLoggedIn = true;
    },
    async captureLsPayload() {
      const url = currentUrl as string;
      calls.captureLs.push(url);
      const attempt = (captureAttempts[url] = (captureAttempts[url] ?? 0) + 1);
      if (cfg.capture) return cfg.capture(url, attempt);
      return payloadFor(url);
    },
    async onLog(level, msg) {
      calls.logs.push([level, msg]);
    },
    async onProgress(stats) {
      calls.progress.push(stats);
    },
  };
  return { deps, calls };
}

describe("collectProductUrlsFromListings — Fase A (discovery)", () => {
  it("1) una página de listado produce dos URLs", async () => {
    const { deps } = makeHarness({ listings: [["/a", "/b"]] });
    const { urls, listingPages } = await collectProductUrlsFromListings(deps);
    expect(urls).toEqual(["/a", "/b"]);
    expect(listingPages).toBe(1);
  });
  it("2) dos páginas producen tres URLs únicas", async () => {
    const { deps } = makeHarness({ listings: [["/a", "/b"], ["/c"]] });
    const { urls } = await collectProductUrlsFromListings(deps);
    expect(urls).toEqual(["/a", "/b", "/c"]);
  });
  it("3) una URL repetida se visita una sola vez (dedup)", async () => {
    const { deps } = makeHarness({ listings: [["/a", "/b"], ["/a", "/c"]] });
    const { urls } = await collectProductUrlsFromListings(deps);
    expect(urls).toEqual(["/a", "/b", "/c"]);
  });
  it("4) URLs relativas se resuelven (y se dropean las inválidas)", async () => {
    const { deps } = makeHarness({
      listings: [["p1", "p2", "junk"]],
      resolveUrl: (h) => (h === "junk" ? null : "https://x.com/productos/" + h),
    });
    const { urls } = await collectProductUrlsFromListings(deps);
    expect(urls).toEqual(["https://x.com/productos/p1", "https://x.com/productos/p2"]);
  });
  it("5) orden de descubrimiento estable", async () => {
    const { deps } = makeHarness({ listings: [["/z", "/m", "/a"], ["/m", "/b"]] });
    const { urls } = await collectProductUrlsFromListings(deps);
    expect(urls).toEqual(["/z", "/m", "/a", "/b"]);
  });
  it("6) maxListingPages corta la paginación", async () => {
    const { deps, calls } = makeHarness({ listings: [["/a"], ["/b"], ["/c"]], maxListingPages: 2 });
    const { urls, listingPages } = await collectProductUrlsFromListings(deps);
    expect(listingPages).toBe(2);
    expect(urls).toEqual(["/a", "/b"]);
    expect(calls.extractListing).toBe(2);
  });
  it("7) ausencia de siguiente termina discovery", async () => {
    const { deps, calls } = makeHarness({ listings: [["/a"]] });
    const { listingPages } = await collectProductUrlsFromListings(deps);
    expect(listingPages).toBe(1);
    expect(calls.goToNextListing).toBe(1); // se intentó avanzar una vez, devolvió false
  });
  it("8) cancelación durante listings corta", async () => {
    let n = 0;
    const { deps } = makeHarness({ listings: [["/a"], ["/b"], ["/c"]], isCancelled: () => ++n > 1 });
    const { urls } = await collectProductUrlsFromListings(deps);
    expect(urls.length).toBeLessThan(3);
  });
});

describe("mapProductPagePayloadToReducedRows — Fase B (mapping por ficha)", () => {
  it("9/10) una ficha con dos variantes produce dos filas reducidas", () => {
    const rows = mapProductPagePayloadToReducedRows(
      payloadFor("/p", [
        { id: "1", product_id: "100", sku: "A", option0: "Rojo", price_number: 100, price_without_taxes: "$82,64", available: true, image_url: "//i1" },
        { id: "2", product_id: "100", sku: "A", option0: "Azul", price_number: 100, price_without_taxes: "$82,64", available: true, image_url: "//i2" },
      ]),
      5,
      FIXED_NOW,
    );
    expect(rows.length).toBe(2);
    expect(rows[0].sourcePageIndex).toBe(5);
    expect(rows[0].sourceVariantIndex).toBe(0);
    expect(rows[1].sourceVariantIndex).toBe(1);
    expect(rows[0].rawSku).toBe("A");
  });
  it("11) window.LS ausente (payload null) → [] sin throw", () => {
    expect(mapProductPagePayloadToReducedRows(null, 0, FIXED_NOW)).toEqual([]);
  });
  it("12) variants ausente → []", () => {
    expect(mapProductPagePayloadToReducedRows({ productName: null, productUrl: null, domLabels: [] } as unknown as RawLsPagePayload, 0, FIXED_NOW)).toEqual([]);
  });
  it("13) array vacío → []", () => {
    expect(mapProductPagePayloadToReducedRows(payloadFor("/p", []), 0, FIXED_NOW)).toEqual([]);
  });
  it("capturedAt inyectado es determinístico", () => {
    const rows = mapProductPagePayloadToReducedRows(payloadFor("/p"), 0, FIXED_NOW);
    expect((rows[0] as Record<string, unknown>).capturedAt).toBe(FIXED_NOW);
  });
});

describe("captureProductRows — retry / re-login", () => {
  it("14/15) fallo transitorio → retry; éxito conserva la ficha una sola vez", async () => {
    const { deps, calls } = makeHarness({
      listings: [],
      capture: (url, attempt) => {
        if (attempt === 1) throw new Error("transient");
        return payloadFor(url);
      },
    });
    const rows = await captureProductRows("/p", 0, deps);
    expect(rows).not.toBeNull();
    expect(rows!.length).toBe(1);
    expect(calls.captureLs.length).toBe(2); // 1 fallo + 1 éxito
  });
  it("16) fallo definitivo → null (reporta y continúa)", async () => {
    const { deps, calls } = makeHarness({
      listings: [],
      maxProductRetries: 2,
      capture: () => {
        throw new Error("always");
      },
    });
    const rows = await captureProductRows("/p", 0, deps);
    expect(rows).toBeNull();
    expect(calls.captureLs.length).toBe(3); // intento inicial + 2 retries
    expect(calls.logs.some(([l]) => l === "WARN")).toBe(true);
  });
  it("17) redirección a login → re-login y vuelve a la ficha", async () => {
    const { deps, calls } = makeHarness({ listings: [], redirectToLogin: new Set(["/p"]) });
    const rows = await captureProductRows("/p", 0, deps);
    expect(rows!.length).toBe(1);
    expect(calls.reLogin).toBe(1);
    expect(calls.navigate).toEqual(["/p", "/p"]); // navega, redirige, re-login, re-navega
  });
});

describe("runSkuFirstWalk — orquestación de dos fases", () => {
  it("19) nunca usa goToNextListing dentro de una ficha (solo entre listados)", async () => {
    const { deps, calls } = makeHarness({ listings: [["/a", "/b"], ["/c"]] });
    await runSkuFirstWalk(deps);
    // 2 listados: 1 avance exitoso + 1 intento final que devuelve false = 2 llamadas
    expect(calls.goToNextListing).toBe(2);
    // 3 fichas visitadas
    expect(calls.navigate).toEqual(["/a", "/b", "/c"]);
  });
  it("20) agrupa todas las filas solo al final", async () => {
    const { deps } = makeHarness({ listings: [["/a", "/b"]] });
    const r = await runSkuFirstWalk(deps);
    expect(r.products.length).toBe(2); // SKU-/a y SKU-/b
    expect(r.stats.productsDiscovered).toBe(2);
    expect(r.stats.productsVisited).toBe(2);
    expect(r.stats.variantsCaptured).toBe(2);
  });
  it("18) cancelación durante fichas → no visita las restantes", async () => {
    let n = 0;
    const { deps, calls } = makeHarness({ listings: [["/a", "/b", "/c"]], isCancelled: () => n++ >= 1 });
    await runSkuFirstWalk(deps);
    expect(calls.navigate.length).toBeLessThan(3);
  });
  it("24) progreso distingue listados, fichas visitadas y variantes", async () => {
    const { deps, calls } = makeHarness({ listings: [["/a"], ["/b"]] });
    await runSkuFirstWalk(deps);
    const last = calls.progress[calls.progress.length - 1] as Record<string, number>;
    expect(last.listingPagesProcessed).toBe(2);
    expect(last.productsVisited).toBe(2);
    expect(last.variantsCaptured).toBe(2);
  });
  it("26) una ficha fallida no elimina variantes de fichas ya procesadas", async () => {
    const { deps } = makeHarness({
      listings: [["/ok", "/bad", "/ok2"]],
      capture: (url) => {
        if (url === "/bad") throw new Error("boom");
        return payloadFor(url);
      },
      maxProductRetries: 0,
    });
    const r = await runSkuFirstWalk(deps);
    expect(r.products.length).toBe(2); // /ok y /ok2 sobreviven
    expect(r.stats.productsFailed).toBe(1);
    expect(r.stats.variantsCaptured).toBe(2);
  });
  it("25) logs no incluyen payload, cookies ni credenciales", async () => {
    const { deps, calls } = makeHarness({ listings: [["/a"]], redirectToLogin: new Set(["/a"]) });
    await runSkuFirstWalk(deps);
    const blob = JSON.stringify(calls.logs);
    expect(/password|cookie|token|authorization|variants|window\.LS/i.test(blob)).toBe(false);
  });
  it("11-bis) window.LS ausente en una ficha → warning y continúa", async () => {
    const { deps, calls } = makeHarness({
      listings: [["/empty", "/ok"]],
      capture: (url) => (url === "/empty" ? ({ productName: null, productUrl: url, domLabels: [], variants: [] }) : payloadFor(url)),
    });
    const r = await runSkuFirstWalk(deps);
    expect(r.products.length).toBe(1); // solo /ok
    expect(calls.logs.some(([l, m]) => l === "WARN" && /variant/i.test(m))).toBe(true);
  });
  it("27) el orden final no depende de la finalización temporal de retries", async () => {
    // /b falla una vez (retry) — /a y /c ok. El orden final por SKU debe ser estable.
    const { deps } = makeHarness({
      listings: [["/a", "/b", "/c"]],
      capture: (url, attempt) => {
        if (url === "/b" && attempt === 1) throw new Error("slow");
        return payloadFor(url);
      },
    });
    const r1 = await runSkuFirstWalk(deps);
    const skus1 = r1.products.map((p) => p.sku);
    expect(skus1).toEqual([...skus1].sort());
    expect(r1.products.length).toBe(3);
  });
});
