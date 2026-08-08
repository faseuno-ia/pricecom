// 2G-R8-Q2 · §3/§11/§13 — captureProductRows: modelo de outcome de ficha + recuperación 429
// reactiva (single owner). Sin red: navegación por SECUENCIA scripteada, sleep FAKE (registra
// sin dormir), Retry-After inyectable. Cubre T1-T5, T9-T18, T21 del §19.
import { describe, it, expect } from "vitest";
import {
  captureProductRows,
  type WalkerDeps,
  type RawLsPagePayload,
  type NavigateResult,
  type RateLimitEvent,
  type RateLimitWalkBudget,
} from "@/lib/scraper/tiendanube-walker";
import { WALK_429_SLEEP_BUDGET_MS } from "@/lib/scraper/http-429-recovery";

const FIXED_NOW = "2026-08-08T00:00:00.000Z";

interface NavSpec { status?: number | null; redirectedToLogin?: boolean; retryAfter?: string | null; throw?: boolean }
const variant = (sku: string | null, price: number | null) => ({ id: 2, product_id: 1, sku, option0: "Rojo", price_number: price });
const payload = (variants: Record<string, unknown>[], url = "https://x.com/productos/a"): RawLsPagePayload =>
  ({ productName: "P", productUrl: url, domLabels: ["Color"], variants });

function makeDeps(cfg: {
  navSequence: NavSpec[];
  capture?: () => RawLsPagePayload; // puede throw
  captureThrowsOnce?: boolean;
  maxProductRetries?: number;
} = { navSequence: [{ status: 200 }] }) {
  const sleeps: number[] = [];
  const navCalls: string[] = [];
  const rlEvents: RateLimitEvent[] = [];
  let navIdx = 0;
  let captureCalls = 0;
  const deps: WalkerDeps = {
    extractListingProductUrls: async () => [],
    resolveUrl: (h) => h,
    goToNextListing: async () => false,
    maxListingPages: 0,
    maxProductRetries: cfg.maxProductRetries ?? 2,
    navigateToProduct: async (url: string): Promise<NavigateResult> => {
      navCalls.push(url);
      const spec = cfg.navSequence[Math.min(navIdx, cfg.navSequence.length - 1)] ?? {};
      navIdx++;
      if (spec.throw) throw new Error("nav throw");
      return { redirectedToLogin: spec.redirectedToLogin ?? false, status: spec.status ?? 200, retryAfter: spec.retryAfter ?? null };
    },
    reLogin: async () => {},
    captureLsPayload: async () => {
      captureCalls++;
      if (cfg.captureThrowsOnce && captureCalls === 1) throw new Error("capture throw once");
      return cfg.capture ? cfg.capture() : payload([variant("SKU-A", 100)]);
    },
    sleep: async (ms: number) => { sleeps.push(ms); },
    onRateLimit: (ev) => { rlEvents.push(ev); },
    now: () => FIXED_NOW,
    nowMs: () => 0,
    isCancelled: () => false,
    onLog: async () => {},
    onProgress: async () => {},
  };
  return { deps, sleeps, navCalls, rlEvents };
}

const budget = (ms = WALK_429_SLEEP_BUDGET_MS): RateLimitWalkBudget => ({ remainingMs: ms, totalSleptMs: 0 });

describe("captureProductRows · outcome VERIFIED_OK + recuperación 429", () => {
  it("T1) 200 inicial → 1 request, 0 retry, VERIFIED_OK", async () => {
    const { deps, sleeps, navCalls } = makeDeps({ navSequence: [{ status: 200 }] });
    const res = await captureProductRows("https://x.com/productos/a", 0, deps);
    expect(res.outcome).toBe("VERIFIED_OK");
    expect(res.documentRequests).toBe(1);
    expect(res.recoveryAttempts).toBe(0);
    expect(res.recoveredAfter429).toBe(false);
    expect(res.variantSetComplete).toBe(true);
    expect(navCalls.length).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it("T2) 429 → 1s → 200 → 2 requests, VERIFIED_OK, recovered, attempts=1", async () => {
    const { deps, sleeps } = makeDeps({ navSequence: [{ status: 429 }, { status: 200 }] });
    const res = await captureProductRows("https://x.com/productos/a", 0, deps, { rateLimitBudget: budget() });
    expect(res.outcome).toBe("VERIFIED_OK");
    expect(res.documentRequests).toBe(2);
    expect(res.recoveredAfter429).toBe(true);
    expect(res.recoveryAttempts).toBe(1);
    expect(sleeps).toEqual([1000]);
    expect(res.variantSetComplete).toBe("unknown"); // §3.2: captura perturbada por 429
  });

  it("T3) 429 → 429 → 200 → 3 requests, recovered, attempts=2", async () => {
    const { deps, sleeps } = makeDeps({ navSequence: [{ status: 429 }, { status: 429 }, { status: 200 }] });
    const res = await captureProductRows("https://x.com/productos/a", 0, deps, { rateLimitBudget: budget() });
    expect(res.outcome).toBe("VERIFIED_OK");
    expect(res.documentRequests).toBe(3);
    expect(res.recoveryAttempts).toBe(2);
    expect(sleeps).toEqual([1000, 2000]);
  });

  it("T4) 429 × 3 → 200 → 4 requests, recovered", async () => {
    const { deps, sleeps } = makeDeps({ navSequence: [{ status: 429 }, { status: 429 }, { status: 429 }, { status: 200 }] });
    const res = await captureProductRows("https://x.com/productos/a", 0, deps, { rateLimitBudget: budget() });
    expect(res.outcome).toBe("VERIFIED_OK");
    expect(res.documentRequests).toBe(4);
    expect(res.recoveryAttempts).toBe(3);
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });
});

describe("captureProductRows · RATE_LIMITED (exhaustion) — SIN multiplicación (§2)", () => {
  it("T5) 429 × 4 → EXACTAMENTE 4 requests → RATE_LIMITED, ningún outer retry", async () => {
    const { deps, navCalls, sleeps } = makeDeps({ navSequence: [{ status: 429 }] }); // clamp: siempre 429
    const res = await captureProductRows("https://x.com/productos/a", 0, deps, { rateLimitBudget: budget() });
    expect(res.outcome).toBe("RATE_LIMITED");
    expect(res.documentRequests).toBe(4); // MAX_TOTAL_DOCUMENT_REQUESTS_FOR_ONE_429_PRODUCT
    expect(navCalls.length).toBe(4); // NO 12 → el loop externo de excepción no lo re-dispara
    expect(res.recoveryAttempts).toBe(3);
    expect(sleeps).toEqual([1000, 2000, 4000]);
  });

  it("no-multiplicación: recovery + throw de captura NO reinicia el budget 429 (contador ficha-scoped)", async () => {
    // 429 → 200(recovered) → captura throw una vez → outer retry navega 200 → captura ok.
    const { deps, sleeps, navCalls } = makeDeps({
      navSequence: [{ status: 429 }, { status: 200 }, { status: 200 }],
      captureThrowsOnce: true,
    });
    const res = await captureProductRows("https://x.com/productos/a", 0, deps, { rateLimitBudget: budget() });
    expect(res.outcome).toBe("VERIFIED_OK");
    expect(sleeps).toEqual([1000]); // UN solo sleep 429 en toda la ficha (no se duplicó el budget)
    expect(navCalls.length).toBe(3);
  });

  it("T9) budget insuficiente → NO excede budget → RATE_LIMITED, sin dormir", async () => {
    const { deps, sleeps, rlEvents } = makeDeps({ navSequence: [{ status: 429 }] });
    const res = await captureProductRows("https://x.com/productos/a", 0, deps, { rateLimitBudget: budget(500) });
    expect(res.outcome).toBe("RATE_LIMITED");
    expect(sleeps).toEqual([]); // 1000 > 500 → exhaustion antes de dormir
    expect(rlEvents.some((e) => e.kind === "BUDGET_EXHAUSTED")).toBe(true);
  });
});

describe("captureProductRows · DATA_INCOMPLETE / READ_FAILED (§3.3/§3.5)", () => {
  it("T10) 429 recuperado a 200 pero captura incompleta → DATA_INCOMPLETE (no RATE_LIMITED)", async () => {
    const { deps } = makeDeps({ navSequence: [{ status: 429 }, { status: 200 }], capture: () => payload([]) });
    const res = await captureProductRows("https://x.com/productos/a", 0, deps, { rateLimitBudget: budget() });
    expect(res.outcome).toBe("DATA_INCOMPLETE");
    expect(res.recoveredAfter429).toBe(true);
    expect(res.rows).toEqual([]);
  });

  it("T12) HTTP200 + captura incompleta (0 variantes) → DATA_INCOMPLETE", async () => {
    const { deps } = makeDeps({ navSequence: [{ status: 200 }], capture: () => payload([]) });
    const res = await captureProductRows("https://x.com/productos/a", 0, deps);
    expect(res.outcome).toBe("DATA_INCOMPLETE");
    expect(res.variantSetComplete).toBe("unknown");
  });

  it("T11) navegación terminal (throw en cada intento) → READ_FAILED", async () => {
    const { deps, navCalls } = makeDeps({ navSequence: [{ throw: true }], maxProductRetries: 2 });
    const res = await captureProductRows("https://x.com/productos/a", 0, deps);
    expect(res.outcome).toBe("READ_FAILED");
    expect(navCalls.length).toBe(3); // 1 + 2 retries de excepción
  });
});

describe("captureProductRows · SKU presente sin precio (§8)", () => {
  it("T13) HTTP200 + SKU presente + sin precio → VERIFIED_OK, evidencia preservada (NO DATA_INCOMPLETE)", async () => {
    const { deps } = makeDeps({ navSequence: [{ status: 200 }], capture: () => payload([variant("SKU-SINPRECIO", null)]) });
    const res = await captureProductRows("https://x.com/productos/a", 0, deps);
    expect(res.outcome).toBe("VERIFIED_OK"); // no se degrada a DATA_INCOMPLETE
    expect(res.rows.length).toBe(1);
    expect(res.rows[0].rawSku).toBe("SKU-SINPRECIO");
    expect(res.rows[0].priceNumber).toBeNull(); // precio ausente preservado para Q2.1
  });
});

describe("captureProductRows · budget sleep total (§13) y prohibición de VERIFIED_ABSENT (§5)", () => {
  it("T14) sin 429 → TOTAL_429_SLEEP_MS = 0", async () => {
    const b = budget();
    const { deps, sleeps } = makeDeps({ navSequence: [{ status: 200 }] });
    const res = await captureProductRows("https://x.com/productos/a", 0, deps, { rateLimitBudget: b });
    expect(res.sleptMs).toBe(0);
    expect(b.totalSleptMs).toBe(0);
    expect(sleeps).toEqual([]);
  });

  it("T15/T16/T17) RATE_LIMITED / READ_FAILED / DATA_INCOMPLETE NUNCA producen VERIFIED_ABSENT", async () => {
    const rate = await captureProductRows("https://x.com/productos/a", 0, makeDeps({ navSequence: [{ status: 429 }] }).deps, { rateLimitBudget: budget() });
    const read = await captureProductRows("https://x.com/productos/a", 0, makeDeps({ navSequence: [{ throw: true }] }).deps);
    const data = await captureProductRows("https://x.com/productos/a", 0, makeDeps({ navSequence: [{ status: 200 }], capture: () => payload([]) }).deps);
    for (const r of [rate, read, data]) {
      expect(["VERIFIED_OK", "DATA_INCOMPLETE", "RATE_LIMITED", "READ_FAILED"]).toContain(r.outcome);
      expect(r.outcome).not.toBe("VERIFIED_ABSENT" as unknown);
    }
    expect(rate.outcome).toBe("RATE_LIMITED");
    expect(read.outcome).toBe("READ_FAILED");
    expect(data.outcome).toBe("DATA_INCOMPLETE");
  });

  it("T18) VERIFIED_OK recuperado tras 429 → variantSetComplete != true (ausencia de variante PROHIBIDA)", async () => {
    const clean = await captureProductRows("https://x.com/productos/a", 0, makeDeps({ navSequence: [{ status: 200 }] }).deps);
    const recovered = await captureProductRows("https://x.com/productos/a", 0, makeDeps({ navSequence: [{ status: 429 }, { status: 200 }] }).deps, { rateLimitBudget: budget() });
    expect(clean.outcome).toBe("VERIFIED_OK");
    expect(clean.variantSetComplete).toBe(true);
    expect(recovered.outcome).toBe("VERIFIED_OK");
    expect(recovered.variantSetComplete).not.toBe(true); // "unknown" → no autoriza inferir ausencia de variante
    expect(recovered.variantSetComplete).toBe("unknown");
  });
});

describe("captureProductRows · §10/§21 la navegación reintenta la URL ORIGINAL byte por byte", () => {
  it("T21a) trailing slash: reintento navega EXACTAMENTE la misma cadena con '/'", async () => {
    const url = "https://x.com/productos/producto/";
    const { deps, navCalls } = makeDeps({ navSequence: [{ status: 429 }, { status: 200 }] });
    await captureProductRows(url, 0, deps, { rateLimitBudget: budget() });
    expect(navCalls).toEqual([url, url]);
    expect(navCalls.every((u) => u === url)).toBe(true); // nunca canonicaliza ni quita el slash
  });

  it("T21b) sin trailing slash: reintento navega EXACTAMENTE la misma cadena sin '/'", async () => {
    const url = "https://x.com/productos/producto";
    const { deps, navCalls } = makeDeps({ navSequence: [{ status: 429 }, { status: 429 }, { status: 200 }] });
    await captureProductRows(url, 0, deps, { rateLimitBudget: budget() });
    expect(navCalls).toEqual([url, url, url]);
  });
});
