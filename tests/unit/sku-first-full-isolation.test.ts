// 2G-R8-Q2 · §18 — AISLAMIENTO FULL/LEGACY (GATE DURO).
// La recuperación 429 vive EXCLUSIVAMENTE en el path SKU-first (captureProductRows). Debe
// probarse que: (a) es INERTE sin 429 — una navegación FULL-style (status != 429) no duerme
// ni reintenta 429; (b) el owner 429 (http-429-recovery) está importado SÓLO por el walker
// SKU-first dentro de lib/scraper — ningún módulo del path FULL/legacy lo toca.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  captureProductRows,
  type WalkerDeps,
  type RawLsPagePayload,
  type NavigateResult,
} from "@/lib/scraper/tiendanube-walker";

const payload = (): RawLsPagePayload => ({
  productName: "P", productUrl: "https://x.com/productos/a", domLabels: ["C"],
  variants: [{ id: 2, product_id: 1, sku: "S", option0: "R", price_number: 100 }],
});

function inertDeps() {
  const sleeps: number[] = [];
  const rlEvents: unknown[] = [];
  const navCalls: string[] = [];
  const deps: WalkerDeps = {
    extractListingProductUrls: async () => [],
    resolveUrl: (h) => h,
    goToNextListing: async () => false,
    maxListingPages: 0,
    maxProductRetries: 2,
    navigateToProduct: async (url): Promise<NavigateResult> => { navCalls.push(url); return { redirectedToLogin: false, status: 200, retryAfter: "5" }; },
    reLogin: async () => {},
    captureLsPayload: async () => payload(),
    sleep: async (ms) => { sleeps.push(ms); },
    onRateLimit: (ev) => { rlEvents.push(ev); },
    now: () => "2026-08-08T00:00:00.000Z",
    nowMs: () => 0,
    isCancelled: () => false,
    onLog: async () => {},
    onProgress: async () => {},
  };
  return { deps, sleeps, rlEvents, navCalls };
}

describe("§18 · la recuperación 429 es INERTE sin 429 (comportamiento FULL/legacy intacto)", () => {
  it("T20a) status 200 (aunque venga Retry-After en el header) → 0 sleep, 0 eventos 429, 1 request, VERIFIED_OK", async () => {
    const { deps, sleeps, rlEvents, navCalls } = inertDeps();
    const res = await captureProductRows("https://x.com/productos/a", 0, deps);
    expect(res.outcome).toBe("VERIFIED_OK");
    expect(sleeps).toEqual([]); // ningún sleep 429 nuevo
    expect(rlEvents.length).toBe(0); // ningún retry/evento 429
    expect(navCalls.length).toBe(1); // misma navegación histórica (1 request)
  });
});

describe("§18 · SCOPE: el owner 429 sólo lo importa el walker SKU-first en lib/scraper", () => {
  it("T20b) http-429-recovery no es importado por ningún módulo del path FULL/legacy", () => {
    const dir = resolve(process.cwd(), "lib/scraper");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    const importers = files.filter((f) => {
      const src = readFileSync(resolve(dir, f), "utf8");
      return /["'`]\.\/http-429-recovery["'`]/.test(src);
    });
    // ÚNICO importer productivo dentro de lib/scraper: el walker SKU-first.
    expect(importers.sort()).toEqual(["tiendanube-walker.ts"]);
  });

  it("T20c) el path legacy de paginación (goToNextPage) no contiene recuperación 429", () => {
    const src = readFileSync(resolve(process.cwd(), "lib/scraper/scraper.service.ts"), "utf8");
    const start = src.indexOf("private async goToNextPage");
    expect(start).toBeGreaterThan(-1);
    // Acotar al cuerpo del método (hasta el próximo `private async`).
    const rest = src.slice(start + 20);
    const end = rest.indexOf("\n  private async ");
    const body = end === -1 ? rest : rest.slice(0, end);
    expect(/compute429Delay|parseRetryAfterMs|MAX_429_RETRIES/.test(body)).toBe(false);
    // El manejo histórico de status en la paginación legacy sigue siendo end-of-pagination (≥400).
    expect(/status >= 400/.test(body)).toBe(true);
  });
});
