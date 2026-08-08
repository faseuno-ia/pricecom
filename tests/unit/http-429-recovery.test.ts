// 2G-R8-Q2 · Política PURA 429 (§11-§13). Retry-After (delta-seconds/HTTP-date), cap y budget.
import { describe, it, expect } from "vitest";
import {
  MAX_429_RETRIES,
  MAX_SINGLE_429_DELAY_MS,
  WALK_429_SLEEP_BUDGET_MS,
  FALLBACK_429_DELAYS_MS,
  parseRetryAfterMs,
  compute429Delay,
} from "@/lib/scraper/http-429-recovery";

const NOW = Date.parse("2026-08-08T12:00:00.000Z");

describe("contrato congelado (§11-§13)", () => {
  it("constantes pre-registradas", () => {
    expect(MAX_429_RETRIES).toBe(3);
    expect(MAX_SINGLE_429_DELAY_MS).toBe(30000);
    expect(WALK_429_SLEEP_BUDGET_MS).toBe(120000);
    expect([...FALLBACK_429_DELAYS_MS]).toEqual([1000, 2000, 4000]);
  });
});

describe("parseRetryAfterMs", () => {
  it("T6) delta-seconds → ms", () => {
    expect(parseRetryAfterMs("120", NOW)).toBe(120000);
    expect(parseRetryAfterMs("0", NOW)).toBe(0);
    expect(parseRetryAfterMs("  5 ", NOW)).toBe(5000);
  });
  it("T7) HTTP-date → max(0, fecha − now)", () => {
    const in5s = new Date(NOW + 5000).toUTCString(); // segundos-resolución
    expect(parseRetryAfterMs(in5s, NOW)).toBe(5000);
    const past = new Date(NOW - 10000).toUTCString();
    expect(parseRetryAfterMs(past, NOW)).toBe(0); // fecha pasada → 0, nunca negativo
  });
  it("ausente/vacío/no-parseable → null", () => {
    expect(parseRetryAfterMs(null, NOW)).toBeNull();
    expect(parseRetryAfterMs(undefined, NOW)).toBeNull();
    expect(parseRetryAfterMs("", NOW)).toBeNull();
    expect(parseRetryAfterMs("no-una-fecha", NOW)).toBeNull();
  });
});

describe("compute429Delay", () => {
  it("sin Retry-After → fallback pre-registrado por reintento 1-based", () => {
    expect(compute429Delay({ attempt: 1, retryAfterMs: null, remainingBudgetMs: 120000 }).appliedDelayMs).toBe(1000);
    expect(compute429Delay({ attempt: 2, retryAfterMs: null, remainingBudgetMs: 120000 }).appliedDelayMs).toBe(2000);
    expect(compute429Delay({ attempt: 3, retryAfterMs: null, remainingBudgetMs: 120000 }).appliedDelayMs).toBe(4000);
    // fuera de rango se satura en el último (defensivo)
    expect(compute429Delay({ attempt: 9, retryAfterMs: null, remainingBudgetMs: 120000 }).appliedDelayMs).toBe(4000);
  });
  it("con Retry-After válido → usa ese valor", () => {
    const d = compute429Delay({ attempt: 1, retryAfterMs: 7000, remainingBudgetMs: 120000 });
    expect(d.appliedDelayMs).toBe(7000);
    expect(d.retryAfterPresent).toBe(true);
    expect(d.capped).toBe(false);
  });
  it("T8) Retry-After > 30000ms → cap a 30000, capped=true", () => {
    const d = compute429Delay({ attempt: 1, retryAfterMs: 60000, remainingBudgetMs: 120000 });
    expect(d.appliedDelayMs).toBe(30000);
    expect(d.capped).toBe(true);
    expect(d.exceedsBudget).toBe(false); // 30000 cabe en 120000
  });
  it("cap se aplica ANTES del budget: Retry-After gigante capeado que sí cabe no marca exhaustion", () => {
    const d = compute429Delay({ attempt: 1, retryAfterMs: 999999, remainingBudgetMs: 40000 });
    expect(d.appliedDelayMs).toBe(30000);
    expect(d.capped).toBe(true);
    expect(d.exceedsBudget).toBe(false);
  });
  it("delay > budget restante → exceedsBudget=true (§13)", () => {
    const d = compute429Delay({ attempt: 3, retryAfterMs: null, remainingBudgetMs: 3000 }); // fallback 4000 > 3000
    expect(d.appliedDelayMs).toBe(4000);
    expect(d.exceedsBudget).toBe(true);
  });
});
