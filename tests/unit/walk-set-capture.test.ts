// G1 §7 — la instrumentación real del WALK_SET (acceptedCaptureUrl) no registra capturas
// fallidas/rechazadas; compuesto con el adapter demuestra el fail-closed (fail-open guard).
import { describe, it, expect } from "vitest";
import { acceptedCaptureUrl } from "@/lib/scraper/walk-set-capture";
import { resolveTwoSnapshotCompleteness } from "@/lib/scraper/sitemap-two-snapshot";
import type { SitemapSnapshot } from "@/lib/scraper/runtime-sitemap-reference";

const PU = "https://differenttouch.com.ar/productos/ficha-a";
const NPU = "differenttouch.com.ar/productos/ficha-a";
const LOGIN = "https://differenttouch.com.ar/account/login/";

describe("acceptedCaptureUrl — aceptación de captura (§5/§6)", () => {
  it("payload con variantes + identidad coherente → registra normalizado", () => {
    expect(acceptedCaptureUrl({ variants: [{}], productUrl: PU }, PU)).toBe(NPU);
  });
  it("variants.length === 0 → null", () => {
    expect(acceptedCaptureUrl({ variants: [], productUrl: PU }, PU)).toBeNull();
  });
  it("payload null / variants no-array → null", () => {
    expect(acceptedCaptureUrl(null, PU)).toBeNull();
    expect(acceptedCaptureUrl({ variants: undefined }, PU)).toBeNull();
  });
  it("identity mismatch (payload.productUrl != page.url()) → null", () => {
    expect(acceptedCaptureUrl({ variants: [{}], productUrl: PU }, "https://differenttouch.com.ar/productos/otra")).toBeNull();
  });
  it("solo payload válido (page en login) → registra payload", () => {
    expect(acceptedCaptureUrl({ variants: [{}], productUrl: PU }, LOGIN)).toBe(NPU);
  });
  it("solo page válido (payload sin url) → registra page", () => {
    expect(acceptedCaptureUrl({ variants: [{}], productUrl: null }, PU)).toBe(NPU);
  });
  it("no-producto (home) → null", () => {
    expect(acceptedCaptureUrl({ variants: [{}], productUrl: null }, "https://differenttouch.com.ar/")).toBeNull();
  });
});

describe("§7 — captura fallida/rechazada NO cuenta como cobertura → fail-closed", () => {
  const A = "https://differenttouch.com.ar/productos/a";
  const B = "https://differenttouch.com.ar/productos/b";
  const nA = "differenttouch.com.ar/productos/a";
  const nB = "differenttouch.com.ar/productos/b";
  const MIN = 2;
  const pop = (urls: string[]): SitemapSnapshot => ({ kind: "POPULATED", urls, rawLocCount: urls.length, productLocCount: urls.length });
  const buildWalkSet = (captures: Array<{ payload: any; pageUrl: string }>): string[] => {
    const set = new Set<string>();
    for (const c of captures) { const u = acceptedCaptureUrl(c.payload, c.pageUrl); if (u) set.add(u); }
    return [...set];
  };
  const okA = { payload: { variants: [{}], productUrl: A }, pageUrl: A };

  const cases: Array<{ label: string; captures: Array<{ payload: any; pageUrl: string }> }> = [
    { label: "timeout/throw (B nunca llega al wrapper)", captures: [okA] },
    { label: "B redirect a login (page=login, payload sin url)", captures: [okA, { payload: { variants: [{}], productUrl: null }, pageUrl: LOGIN }] },
    { label: "B payload variants=0", captures: [okA, { payload: { variants: [], productUrl: B }, pageUrl: B }] },
    { label: "B payload inválido (null)", captures: [okA, { payload: null, pageUrl: B }] },
    { label: "B identity mismatch", captures: [okA, { payload: { variants: [{}], productUrl: B }, pageUrl: "https://differenttouch.com.ar/productos/c" }] },
  ];
  for (const c of cases) {
    it(`${c.label} → B ∉ WALK_SET → BLOCKING_MISSING=1 → fail-closed`, () => {
      const walkSet = buildWalkSet(c.captures);
      expect(walkSet).toEqual([nA]);
      const r = resolveTwoSnapshotCompleteness({ start: pop([nA, nB]), end: pop([nA, nB]), walkSet, minExpectedProducts: MIN });
      expect(r.complete).toBe(false);
      expect(r.diagnostics.blockingMissingCount).toBe(1);
      expect(r.diagnostics.blockingMissingSample).toEqual([nB]);
    });
  }
  it("A aceptada + B aceptada → cobertura total → COMPLETE (piso bajo del test)", () => {
    const walkSet = buildWalkSet([okA, { payload: { variants: [{}], productUrl: B }, pageUrl: B }]);
    expect(walkSet.sort()).toEqual([nA, nB]);
    const r = resolveTwoSnapshotCompleteness({ start: pop([nA, nB]), end: pop([nA, nB]), walkSet, minExpectedProducts: MIN });
    expect(r.complete).toBe(true);
  });
});
