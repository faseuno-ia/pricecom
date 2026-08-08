// 2G-R3 — discovery sitemap-driven. Prueba el seam PURO del walker (deps inyectadas, sin browser):
// el START_SET se usa como semilla; la Fase A de listados se saltea; el ACCEPTED_WALK_SET
// (autoridad de completitud) se llena SOLO con capturas aceptadas en Fase B, nunca con el seed.
// Reproduce además el incidente 2G: con seed, goToNextListing NUNCA se llama ⇒ nunca hay
// paginación `/account/login/page/N/`.
import { describe, it, expect, vi } from "vitest";
import {
  runSkuFirstWalk,
  collectProductUrlsFromSeed,
  mapProductPagePayloadToReducedRows,
  type WalkerDeps,
  type RawLsPagePayload,
} from "@/lib/scraper/tiendanube-walker";
import { groupSkuFirst, type TnReducedRow } from "@/lib/scraper/tiendanube-sku-first";
import { acceptedCaptureUrl } from "@/lib/scraper/walk-set-capture";
import { resolveTwoSnapshotCompleteness } from "@/lib/scraper/sitemap-two-snapshot";
import { normalizeCatalogUrl } from "@/lib/scraper/url-normalization";
import type { SitemapSnapshot } from "@/lib/scraper/runtime-sitemap-reference";

const DT = "https://differenttouch.com.ar";
// Réplica del resolveUrl productivo (base = página post-login, para probar que el seed no
// depende del estado de página que dejó performLogin).
const resolveUrl = (href: string): string | null => {
  try {
    const abs = new URL(href, `${DT}/account/login/`).toString();
    return /\/productos\//.test(abs) ? abs.split("#")[0] : null;
  } catch {
    return null;
  }
};

const variant = (sku: string | null, price: number | null) => ({ id: 2, product_id: 1, sku, option0: "Rojo", price_number: price });
const payloadFor = (url: string, variants: any[]): RawLsPagePayload => ({ productName: "P", productUrl: url, domLabels: ["Color"], variants });

function mockDeps(over: Partial<WalkerDeps> & { payloads?: Record<string, any[]>; failUrls?: string[] } = {}): WalkerDeps {
  let currentUrl = "";
  const payloads = over.payloads ?? {};
  const failUrls = over.failUrls ?? [];
  const base: WalkerDeps = {
    seedProductUrls: undefined,
    extractListingProductUrls: vi.fn(async () => []),
    resolveUrl,
    goToNextListing: vi.fn(async () => false),
    maxListingPages: 150,
    navigateToProduct: vi.fn(async (url: string) => { currentUrl = url; if (failUrls.includes(url)) throw new Error("HTTP 429"); return { redirectedToLogin: false, status: 200 as number | null }; }),
    reLogin: vi.fn(async () => {}),
    captureLsPayload: vi.fn(async () => payloadFor(currentUrl, payloads[currentUrl] ?? [variant("SKU-" + currentUrl.slice(-3), 1000)])),
    maxProductRetries: 2,
    now: () => "2026-08-06T00:00:00Z",
    isCancelled: () => false,
    onLog: vi.fn(async () => {}),
    onProgress: vi.fn(async () => {}),
  };
  const { payloads: _p, failUrls: _f, ...walkerOver } = over;
  return { ...base, ...walkerOver };
}

describe("2G-R3 · collectProductUrlsFromSeed", () => {
  it("canonicaliza, valida por predicado de producto y deduplica", () => {
    const deps = mockDeps();
    const seed = [
      `${DT}/productos/a`,
      `${DT}/productos/a`,            // duplicada
      `${DT}/quienes-somos`,          // no-producto → rechazada
      `${DT}/productos/c#variante`,   // fragmento se descarta
    ];
    const r = collectProductUrlsFromSeed(seed, deps);
    expect(r.urls).toEqual([`${DT}/productos/a`, `${DT}/productos/c`]);
    expect(r.duplicates).toBe(1);
    expect(r.rejected).toBe(1);
  });
});

describe("2G-R3 · runSkuFirstWalk con seed (sitemap-driven)", () => {
  it("NO ejecuta discovery por listados y navega cada URL del seed", async () => {
    const seed = [`${DT}/productos/a`, `${DT}/productos/b`, `${DT}/productos/c`];
    const deps = mockDeps({ seedProductUrls: seed });
    const res = await runSkuFirstWalk(deps);
    expect(deps.extractListingProductUrls).not.toHaveBeenCalled();
    expect(deps.goToNextListing).not.toHaveBeenCalled();
    expect((deps.navigateToProduct as any).mock.calls.map((c: any[]) => c[0])).toEqual(seed);
    expect(res.stats.listingPagesProcessed).toBe(0);
    expect(res.stats.productsDiscovered).toBe(3);
    expect(res.stats.productsVisited).toBe(3);
  });

  it("reproduce el fix del incidente: goToNextListing nunca se llama ⇒ jamás /account/login/page/N/", async () => {
    const seed = [`${DT}/productos/x`];
    const goToNextListing = vi.fn(async () => { throw new Error("no debería paginar listados en modo seed"); });
    const deps = mockDeps({ seedProductUrls: seed, goToNextListing });
    const res = await runSkuFirstWalk(deps);
    expect(goToNextListing).not.toHaveBeenCalled();
    expect(res.products.length).toBe(1);
  });
});

describe("2G-R3 · sin seed conserva discovery legacy por listados", () => {
  it("llama extractListingProductUrls y goToNextListing", async () => {
    const extractListingProductUrls = vi.fn(async () => [`${DT}/productos/a`]);
    const goToNextListing = vi.fn(async () => false);
    const deps = mockDeps({ seedProductUrls: undefined, extractListingProductUrls, goToNextListing });
    const res = await runSkuFirstWalk(deps);
    expect(extractListingProductUrls).toHaveBeenCalledTimes(1);
    expect(goToNextListing).toHaveBeenCalledTimes(1);
    expect(res.stats.listingPagesProcessed).toBe(1);
  });
});

describe("2G-R3 · seed ≠ accepted (completitud no vacua)", () => {
  it("una ficha con variante+SKU produce fila; cero variantes y variante sin SKU no", async () => {
    const withSku = `${DT}/productos/con-sku`;
    const zeroVar = `${DT}/productos/sin-variantes`;
    const emptySku = `${DT}/productos/variante-sin-sku`;
    const deps = mockDeps({
      seedProductUrls: [withSku, zeroVar, emptySku],
      payloads: {
        [withSku]: [variant("REAL-SKU", 1000)],
        [zeroVar]: [],                       // 0 variantes
        [emptySku]: [variant("  ", 1000)],   // variante con SKU vacío → cuarentena
      },
    });
    const res = await runSkuFirstWalk(deps);
    const skus = res.products.map((p: any) => p.sku);
    expect(skus).toEqual(["REAL-SKU"]);
    expect(res.stats.productsVisited).toBe(3);
    // quarantine contiene el SKU vacío
    expect(res.quarantine.some((q: any) => q.reason === "MISSING_SKU")).toBe(true);
  });

  it("una ficha estable que falla toda navegación (p.ej. 429) no produce fila y cuenta como fallida", async () => {
    const ok = `${DT}/productos/ok`;
    const bad = `${DT}/productos/bad`;
    const deps = mockDeps({ seedProductUrls: [ok, bad], failUrls: [bad], payloads: { [ok]: [variant("OK-SKU", 500)] } });
    const res = await runSkuFirstWalk(deps);
    expect(res.products.map((p: any) => p.sku)).toEqual(["OK-SKU"]);
    expect(res.stats.productsFailed).toBe(1);
    // 3 intentos (1 + maxProductRetries) sobre la URL fallida
    expect((deps.navigateToProduct as any).mock.calls.filter((c: any[]) => c[0] === bad).length).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Semántica AUTORITATIVA de sets (2G-R3): ACCEPTED (≥1 variante, no exige SKU) vs
// CATALOG_MAPPABLE (≥1 SKU) vs MISSING_SKU_QUARANTINE. La completitud usa ACCEPTED.
// ─────────────────────────────────────────────────────────────────────────────
const A = `${DT}/productos/a`;
const B = `${DT}/productos/b`;
const C = `${DT}/productos/c`;
const pop = (urls: string[]): SitemapSnapshot => ({ kind: "POPULATED", urls: urls.map((u) => normalizeCatalogUrl(u)!), rawLocCount: urls.length, productLocCount: urls.length });
const cap = (url: string, variants: any[]) => acceptedCaptureUrl({ variants, productUrl: url }, url);

describe("2G-R3 · acceptedCaptureUrl: acepta por variante (no por SKU) + identidad de producto", () => {
  it("acepta con ≥1 variante SIN exigir SKU (no-SKU ENTRA a ACCEPTED_WALK_SET)", () => {
    expect(acceptedCaptureUrl({ variants: [{ sku: "" }], productUrl: A }, A)).toBe(normalizeCatalogUrl(A));
  });
  it("cero variantes → NO aceptado (permanece missing si integra BLOCKING)", () => {
    expect(acceptedCaptureUrl({ variants: [], productUrl: A }, A)).toBeNull();
  });
  it("diferencia cosmética de slash final → canonical equivalente → aceptado (sin falso missing)", () => {
    expect(acceptedCaptureUrl({ variants: [{ sku: "S" }], productUrl: `${DT}/productos/a` }, `${DT}/productos/a/`)).toBe(normalizeCatalogUrl(A));
  });
  it("redirect a OTRO producto → identity mismatch → rechazado", () => {
    expect(acceptedCaptureUrl({ variants: [{ sku: "S" }], productUrl: A }, `${DT}/productos/otro`)).toBeNull();
  });
  it("host distinto www vs apex NO es canonical-equivalente (normalizeCatalogUrl preserva host) → mismatch", () => {
    // Documenta la lógica REAL host-sensitive; §0.ter observó 0 redirects para DT (no ocurre en práctica).
    expect(acceptedCaptureUrl({ variants: [{ sku: "S" }], productUrl: "https://differenttouch.com.ar/productos/a" }, "https://www.differenttouch.com.ar/productos/a")).toBeNull();
  });
});

describe("2G-R3 · completitud no-vacua: no-SKU aceptado no rompe cobertura; vacío/429 sí", () => {
  it("START=END={A(sku),B(no-sku),C(vacío)} → ACCEPTED={A,B}, MISSING={C}, FAIL_CLOSED", () => {
    const walk = [cap(A, [{ sku: "SA" }]), cap(B, [{ sku: "" }]), cap(C, [])].filter((x): x is string => x !== null);
    expect(walk.length).toBe(2); // A y B aceptados (B sin SKU igual entra); C no
    const r = resolveTwoSnapshotCompleteness({ start: pop([A, B, C]), end: pop([A, B, C]), walkSet: walk, minExpectedProducts: 2 });
    expect(r.complete).toBe(false);
    expect(r.diagnostics.blockingMissingCount).toBe(1);
  });
  it("START=END={A(sku),B(no-sku)} → ACCEPTED={A,B}, MISSING=0, COMPLETE", () => {
    const walk = [cap(A, [{ sku: "SA" }]), cap(B, [{ sku: "" }])].filter((x): x is string => x !== null);
    const r = resolveTwoSnapshotCompleteness({ start: pop([A, B]), end: pop([A, B]), walkSet: walk, minExpectedProducts: 2 });
    expect(r.complete).toBe(true);
    expect(r.diagnostics.blockingMissingCount).toBe(0);
  });
  it("no-SKU capturado NO produce fila CatalogProduct (cuarentena MISSING_SKU)", () => {
    const rowsA = mapProductPagePayloadToReducedRows(payloadFor(A, [variant("SA", 1000)]), 0, "t");
    const rowsB = mapProductPagePayloadToReducedRows(payloadFor(B, [variant("", 1000)]), 1, "t");
    const g = groupSkuFirst([...rowsA, ...rowsB] as unknown as TnReducedRow[]);
    expect(g.products.map((p: any) => p.sku)).toEqual(["SA"]);
    expect(g.quarantine.some((q: any) => q.reason === "MISSING_SKU")).toBe(true);
  });
  it("drift START/END: producto removido no genera missing; agregado no se exige", () => {
    const walk = [normalizeCatalogUrl(A)!];
    const removed = resolveTwoSnapshotCompleteness({ start: pop([A, `${DT}/productos/removed`]), end: pop([A]), walkSet: walk, minExpectedProducts: 1 });
    expect(removed.complete).toBe(true);
    expect(removed.diagnostics.removedDuringRunCount).toBe(1);
    const added = resolveTwoSnapshotCompleteness({ start: pop([A]), end: pop([A, `${DT}/productos/added`]), walkSet: walk, minExpectedProducts: 1 });
    expect(added.complete).toBe(true);
    expect(added.diagnostics.addedDuringRunCount).toBe(1);
  });
});

describe("2G-R3 · reconstrucción de navegación https://+canonical es lossless", () => {
  it("normalizeCatalogUrl(https:// + canonical) === canonical (roundtrip idempotente)", () => {
    const raws = [
      "https://differenttouch.com.ar/productos/a",
      "https://differenttouch.com.ar/productos/a/",       // slash final
      "https://www.differenttouch.com.ar/productos/b",    // www
      "https://DifferentTouch.com.ar/productos/case-host", // host mayúsculas
    ];
    let mismatch = 0;
    for (const raw of raws) {
      const canonical = normalizeCatalogUrl(raw)!;
      if (normalizeCatalogUrl(`https://${canonical}`) !== canonical) mismatch++;
    }
    expect(mismatch).toBe(0);
  });
});
