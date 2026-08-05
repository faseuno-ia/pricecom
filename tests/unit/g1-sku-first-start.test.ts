// G1 §1/§2 — orden SITEMAP_START antes del login + supervivencia bounded de diagnósticos.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  prepareSkuFirstStartSnapshot, SkuFirstCompletenessError, sanitizeSkuFirstCompletenessDiagnostics,
} from "@/lib/scraper/sku-first-start";
import type { HttpResponseLike } from "@/lib/scraper/runtime-sitemap-reference";

const ENTRY = "https://differenttouch.com.ar/sitemap.xml";
const mkRes = (status: number, text: string, finalUrl = ENTRY): HttpResponseLike => ({ status, text, finalUrl, header: () => null });
const urlset = (locs: string[]) => `<urlset>` + locs.map((l) => `<url><loc>${l}</loc></url>`).join("") + `</urlset>`;
const PRODUCTS = Array.from({ length: 5 }, (_, i) => `https://differenttouch.com.ar/productos/p${i}`);
const SKU = "TIENDANUBE_LS_VARIANTS_SKU_FIRST";

describe("prepareSkuFirstStartSnapshot — START antes del login (fail-closed impide login)", () => {
  it("legacy (extractionMode null/blank) → null, sitemapFetchFn NO llamado", async () => {
    const fn = vi.fn();
    for (const m of [null, undefined, "", " "]) {
      expect(await prepareSkuFirstStartSnapshot({ extractionMode: m, sitemapFetchFn: fn as any })).toBeNull();
    }
    expect(fn).not.toHaveBeenCalled();
  });
  it("SKU-first + fetchFn ausente → throw R2_SITEMAP_FETCH_FN_MISSING", async () => {
    await expect(prepareSkuFirstStartSnapshot({ extractionMode: SKU })).rejects.toThrow(/R2_SITEMAP_FETCH_FN_MISSING/);
  });
  it("SKU-first + START FETCH_FAILED → throw (login prevenido)", async () => {
    let n = 0;
    const fn = async () => { n++; return mkRes(500, ""); };
    await expect(prepareSkuFirstStartSnapshot({ extractionMode: SKU, sitemapFetchFn: fn as any })).rejects.toThrow(/R2_SITEMAP_START_FETCH_FAILED/);
    expect(n).toBe(2); // 1 + 1 retry de 5xx, luego fail-closed
  });
  it("SKU-first + START EXPLICITLY_EMPTY → throw R2_SITEMAP_REFERENCE_EXPLICITLY_EMPTY", async () => {
    const fn = async () => mkRes(200, urlset(["https://differenttouch.com.ar/contacto"]));
    await expect(prepareSkuFirstStartSnapshot({ extractionMode: SKU, sitemapFetchFn: fn as any }))
      .rejects.toThrow("SKU_FIRST_COMPLETENESS_FAILED: R2_SITEMAP_REFERENCE_EXPLICITLY_EMPTY");
  });
  it("SKU-first + START POPULATED → devuelve snapshot POPULATED (login puede continuar)", async () => {
    const fn = async () => mkRes(200, urlset(PRODUCTS));
    const r = await prepareSkuFirstStartSnapshot({ extractionMode: SKU, sitemapFetchFn: fn as any });
    expect(r?.kind).toBe("POPULATED");
  });
});

describe("§1 — orden estructural en run(): START antes del performLogin inicial", () => {
  it("prepareSkuFirstStartSnapshot precede al performLogin inicial", () => {
    const src = readFileSync(resolve(process.cwd(), "lib/scraper/scraper.service.ts"), "utf8");
    const startIdx = src.indexOf("prepareSkuFirstStartSnapshot({");
    const loginIdx = src.indexOf('await this.performLogin(page, provider, config, onLog, options.effectiveLoginUrl)');
    expect(startIdx).toBeGreaterThan(0);
    expect(loginIdx).toBeGreaterThan(0);
    expect(startIdx).toBeLessThan(loginIdx);
  });
});

describe("§2 — sanitizeSkuFirstCompletenessDiagnostics: bounded, sin listas completas", () => {
  it("preserva reasonCode + counts + SHA + sample≤20", () => {
    const bigSample = Array.from({ length: 50 }, (_, i) => `differenttouch.com.ar/productos/x${i}`);
    const err = new SkuFirstCompletenessError("R2_SITEMAP_SET_MISMATCH", {
      sitemapStartCount: 877, sitemapEndCount: 877, blockingSetCount: 877, walkSetCount: 800,
      blockingMissingCount: 77, minExpectedProducts: 700, blockingMissingSetSha256: "abc",
      blockingMissingSample: bigSample, addedDuringRunCount: 1, removedDuringRunCount: 2,
    });
    const s = sanitizeSkuFirstCompletenessDiagnostics(err);
    expect(s.reasonCode).toBe("R2_SITEMAP_SET_MISMATCH");
    expect(s.blockingMissingCount).toBe(77);
    expect(s.blockingMissingSetSha256).toBe("abc");
    expect(s.minExpectedProducts).toBe(700);
    expect((s.blockingMissingSample as string[]).length).toBe(20);
  });
});
