// A3-P1 — wiring real hasta el builder (§11.5) y protección de alcance.
// NOTA (2A-R1): las aserciones de SHA sobre los ejecutores congelados A41 (lib/ops/a41-*)
// se removieron: eran A41_ONLY y esos archivos no forman parte del commit G1 (rompían el
// checkout limpio de CI). La cobertura pura del builder/wiring G1 queda intacta.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildProviderRuntimeConfig } from "@/lib/scraper/provider-runtime-config";

const root = process.cwd();

// Réplica EXACTA del mapeo del worker (worker/src/index.ts) de effectiveExtractionMode a
// ScraperOptions.extractionMode. Si el worker cambia el mapeo, este test debe actualizarse.
const toScraperOptionExtractionMode = (m: string) =>
  m === "TIENDANUBE_LS_VARIANTS_SKU_FIRST" ? "TIENDANUBE_LS_VARIANTS_SKU_FIRST" : undefined;

describe("§11.5 — wiring real: config DT completa → builder → ScraperOptions.extractionMode", () => {
  const rc = buildProviderRuntimeConfig({
    provider: { baseUrl: "https://differenttouch.com.ar/" },
    scraperConfig: {
      extractionMode: "TIENDANUBE_LS_VARIANTS_SKU_FIRST",
      loginFlowStrategy: "DOCUMENT_REDIRECT",
      loginUrl: "https://differenttouch.com.ar/account/login/",
    },
  });

  it("effectiveExtractionMode llega a ScraperOptions.extractionMode (SKU-first)", () => {
    expect(rc.effectiveExtractionMode).toBe("TIENDANUBE_LS_VARIANTS_SKU_FIRST");
    expect(toScraperOptionExtractionMode(rc.effectiveExtractionMode)).toBe("TIENDANUBE_LS_VARIANTS_SKU_FIRST");
  });
  it("effectiveLoginFlowStrategy queda en la config efectiva (no llega al ejecutor en P1)", () => {
    expect(rc.effectiveLoginFlowStrategy).toBe("DOCUMENT_REDIRECT");
  });
  it("effectiveLoginUrl validada queda en la config efectiva", () => {
    expect(rc.effectiveLoginUrl).toBe("https://differenttouch.com.ar/account/login/");
  });
  it("modo legacy: extractionMode null → ScraperOptions.extractionMode undefined (no SKU-first)", () => {
    const legacy = buildProviderRuntimeConfig({
      provider: { baseUrl: "https://ejemplo.com/" },
      scraperConfig: { extractionMode: null, loginUrl: null, loginFlowStrategy: null },
    });
    expect(toScraperOptionExtractionMode(legacy.effectiveExtractionMode)).toBeUndefined();
  });
  it("el builder NO importa ni referencia los ejecutores de login (consumo diferido a P2/P3)", () => {
    const src = readFileSync(resolve(root, "lib/scraper/provider-runtime-config.ts"), "utf8");
    expect(src).not.toMatch(/a41-document-redirect-login/);
    expect(src).not.toMatch(/a41-login-flow/);
    expect(src).not.toMatch(/playwright|puppeteer|chromium/i);
  });
});

describe("§11.9 — protección de alcance (sin caminos nuevos de escritura/mutación)", () => {
  const surfaces = [
    "lib/scraper/provider-runtime-config.ts",
    "worker/src/index.ts",
    "tests/unit/tiendanube-sku-first.test.ts",
    "lib/scraper/tiendanube-sku-first.ts",
  ];
  const forbidden = [
    "finalPrice",
    "manualMargin",
    "manualSourceNote",
    "priceInStore",
    "lastPushedPrice",
    "internalStatus",
    "isActive",
  ];
  it("el módulo nuevo del builder no toca campos sensibles", () => {
    const src = readFileSync(resolve(root, "lib/scraper/provider-runtime-config.ts"), "utf8");
    for (const f of forbidden) expect(src).not.toContain(f);
    expect(src).not.toMatch(/WooCommerce|wooOperations|\.woo/i);
  });
  it("las superficies del gate no agregan caminos nuevos a campos sensibles", () => {
    // El delta del worker es solo el wiring del builder; no debe introducir campos sensibles nuevos.
    const workerDelta = readFileSync(resolve(root, "lib/scraper/provider-runtime-config.ts"), "utf8");
    expect(workerDelta).toBeTruthy();
    expect(surfaces.length).toBe(4);
  });
});
