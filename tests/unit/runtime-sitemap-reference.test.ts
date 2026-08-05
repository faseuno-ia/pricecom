// G1 — runtime-sitemap-reference: fetch+parse+predicado+normalización+estados+retry (E2).
import { describe, it, expect } from "vitest";
import {
  fetchSitemapSnapshot, isProductDetailUrl, parseRetryAfterMs,
  DIFFERENTTOUCH_SITEMAP_ENTRYPOINT, type HttpResponseLike, type SitemapFetchFn,
} from "@/lib/scraper/runtime-sitemap-reference";

const ENTRY = DIFFERENTTOUCH_SITEMAP_ENTRYPOINT;
const mkRes = (status: number, text: string, finalUrl = ENTRY, headers: Record<string, string> = {}): HttpResponseLike => ({
  status, text, finalUrl,
  header: (n: string) => headers[n.toLowerCase()] ?? null,
});
const urlset = (locs: string[]) =>
  `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">` +
  locs.map((l) => `<url><loc>${l}</loc></url>`).join("") + `</urlset>`;
const noSleep = async () => {};
const PRODUCTS = [
  "https://differenttouch.com.ar/productos/vibrador-normal-nuevo",
  "https://differenttouch.com.ar/productos/consolador-con-ventosa-placer-magico",
];
const NONPRODUCT = [
  "https://differenttouch.com.ar/",
  "https://differenttouch.com.ar/contacto",
  "https://differenttouch.com.ar/productos",
  "https://differenttouch.com.ar/productos/",
  "https://differenttouch.com.ar/sex-toys",
];

describe("isProductDetailUrl — predicado derivado de SM0", () => {
  it("acepta fichas /productos/<slug> (host DT)", () => {
    for (const u of PRODUCTS) expect(isProductDetailUrl(u)).toBe(true);
    expect(isProductDetailUrl("https://www.differenttouch.com.ar/productos/x")).toBe(true);
  });
  it("rechaza no-producto (home, categorías, /productos sin slug, institucionales)", () => {
    for (const u of NONPRODUCT) expect(isProductDetailUrl(u)).toBe(false);
  });
  it("rechaza otro dominio y URL inválida", () => {
    expect(isProductDetailUrl("https://otro.com/productos/x")).toBe(false);
    expect(isProductDetailUrl("no-url")).toBe(false);
  });
});

describe("parseRetryAfterMs", () => {
  it("delta-seconds → ms", () => expect(parseRetryAfterMs("5", 0)).toBe(5000));
  it("HTTP-date → delta desde now", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(parseRetryAfterMs("Thu, 01 Jan 2026 00:00:03 GMT", now)).toBe(3000);
  });
  it("inválido/vacío → null", () => {
    expect(parseRetryAfterMs(null, 0)).toBeNull();
    expect(parseRetryAfterMs("", 0)).toBeNull();
    expect(parseRetryAfterMs("xyz", 0)).toBeNull();
  });
});

describe("fetchSitemapSnapshot — estados", () => {
  const withFetch = (fn: SitemapFetchFn, extra = {}) => fetchSitemapSnapshot({ fetchFn: fn, sleepFn: noSleep, ...extra });

  it("urlset mixto → POPULATED solo con fichas de producto normalizadas y únicas", async () => {
    const snap = await withFetch(async () => mkRes(200, urlset([...PRODUCTS, ...NONPRODUCT, PRODUCTS[0]])));
    expect(snap.kind).toBe("POPULATED");
    if (snap.kind === "POPULATED") {
      expect(snap.urls.sort()).toEqual([
        "differenttouch.com.ar/productos/consolador-con-ventosa-placer-magico",
        "differenttouch.com.ar/productos/vibrador-normal-nuevo",
      ]);
      expect(snap.productLocCount).toBe(3); // 2 únicos + 1 duplicado antes de dedup
    }
  });
  it("urlset sin fichas de producto → EXPLICITLY_EMPTY", async () => {
    const snap = await withFetch(async () => mkRes(200, urlset(NONPRODUCT)));
    expect(snap.kind).toBe("EXPLICITLY_EMPTY");
  });
  it("sitemapindex → FETCH_FAILED UNSUPPORTED_SITEMAPINDEX (no sigue hijos)", async () => {
    const idx = `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://differenttouch.com.ar/sitemap-1.xml</loc></sitemap></sitemapindex>`;
    const snap = await withFetch(async () => mkRes(200, idx));
    expect(snap).toEqual({ kind: "FETCH_FAILED", reason: "UNSUPPORTED_SITEMAPINDEX" });
  });
  it("XML inválido → FETCH_FAILED XML_INVALID", async () => {
    const snap = await withFetch(async () => mkRes(200, "<html>not a sitemap</html>"));
    expect(snap).toEqual({ kind: "FETCH_FAILED", reason: "XML_INVALID" });
  });
  it("finalUrl fuera de dominio (status 200) → CROSS_DOMAIN_RESPONSE", async () => {
    const snap = await withFetch(async () => mkRes(200, urlset(PRODUCTS), "https://dcdn-us.mitiendanube.com/sitemap.xml"));
    expect(snap).toEqual({ kind: "FETCH_FAILED", reason: "CROSS_DOMAIN_RESPONSE" });
  });
});

describe("§5 — defensa en profundidad de redirects (GUARD_2 en el módulo)", () => {
  const one = (res: HttpResponseLike) => { let n = 0; const fn: SitemapFetchFn = async () => { n++; return res; }; return { fn, count: () => n }; };

  it("5.1 · 302 cross-domain → REDIRECT_UNSUPPORTED, 1 request, sin segunda", async () => {
    const { fn, count } = one(mkRes(302, "", ENTRY, { location: "https://dcdn-us.mitiendanube.com/stores/x/sitemap.xml.gz" }));
    const snap = await fetchSitemapSnapshot({ fetchFn: fn, sleepFn: noSleep });
    expect(snap).toEqual({ kind: "FETCH_FAILED", reason: "REDIRECT_UNSUPPORTED" });
    expect(count()).toBe(1);
  });
  it("5.2 · 302 on-domain → REDIRECT_UNSUPPORTED, 1 request", async () => {
    const { fn, count } = one(mkRes(302, "", ENTRY, { location: "https://www.differenttouch.com.ar/sitemap.xml" }));
    const snap = await fetchSitemapSnapshot({ fetchFn: fn, sleepFn: noSleep });
    expect(snap).toEqual({ kind: "FETCH_FAILED", reason: "REDIRECT_UNSUPPORTED" });
    expect(count()).toBe(1);
  });
  it("5.3 · 200 con finalUrl cross-domain (adapter roto con follow) → CROSS_DOMAIN_RESPONSE, XML no parseado", async () => {
    const { fn, count } = one(mkRes(200, urlset(PRODUCTS), "https://dcdn-us.mitiendanube.com/stores/x/sitemap.xml.gz"));
    const snap = await fetchSitemapSnapshot({ fetchFn: fn, sleepFn: noSleep });
    expect(snap).toEqual({ kind: "FETCH_FAILED", reason: "CROSS_DOMAIN_RESPONSE" });
    expect(count()).toBe(1);
  });
  it("5.4 · 200 on-domain → procesamiento normal (POPULATED)", async () => {
    const snap = await fetchSitemapSnapshot({ fetchFn: async () => mkRes(200, urlset(PRODUCTS), ENTRY), sleepFn: noSleep });
    expect(snap.kind).toBe("POPULATED");
  });
});

describe("fetchSitemapSnapshot — política de retry E2", () => {
  const run = (fn: SitemapFetchFn, extra = {}) => fetchSitemapSnapshot({ fetchFn: fn, sleepFn: noSleep, ...extra });

  it("network error → retry único → success", async () => {
    let n = 0;
    const snap = await run(async () => { if (n++ === 0) throw new Error("ECONNRESET"); return mkRes(200, urlset(PRODUCTS)); });
    expect(snap.kind).toBe("POPULATED"); expect(n).toBe(2);
  });
  it("503 → retry único → success", async () => {
    let n = 0;
    const snap = await run(async () => (n++ === 0 ? mkRes(503, "") : mkRes(200, urlset(PRODUCTS))));
    expect(snap.kind).toBe("POPULATED"); expect(n).toBe(2);
  });
  it("segundo fallo transitorio → fail-closed", async () => {
    let n = 0;
    const snap = await run(async () => { n++; return mkRes(503, ""); });
    expect(snap).toEqual({ kind: "FETCH_FAILED", reason: "HTTP_INVALID" }); expect(n).toBe(2);
  });
  it("404 → sin retry", async () => {
    let n = 0;
    const snap = await run(async () => { n++; return mkRes(404, ""); });
    expect(snap.kind).toBe("FETCH_FAILED"); expect(n).toBe(1);
  });
  it("429 sin Retry-After → sin retry → fail-closed", async () => {
    let n = 0;
    const snap = await run(async () => { n++; return mkRes(429, ""); });
    expect(snap).toEqual({ kind: "FETCH_FAILED", reason: "HTTP_429_NO_RETRY" }); expect(n).toBe(1);
  });
  it("429 con Retry-After válido ≤10s → retry único → success", async () => {
    let n = 0;
    const snap = await run(async () => (n++ === 0 ? mkRes(429, "", ENTRY, { "retry-after": "2" }) : mkRes(200, urlset(PRODUCTS))));
    expect(snap.kind).toBe("POPULATED"); expect(n).toBe(2);
  });
  it("429 con Retry-After >10s → sin retry → fail-closed", async () => {
    let n = 0;
    const snap = await run(async () => { n++; return mkRes(429, "", ENTRY, { "retry-after": "30" }); });
    expect(snap).toEqual({ kind: "FETCH_FAILED", reason: "HTTP_429_NO_RETRY" }); expect(n).toBe(1);
  });
});
