// 2G-R8-Q2 — Política PURA de recuperación reactiva ante HTTP 429 (SINGLE OWNER).
//
// Sin Playwright, sin red, sin DB, sin reloj propio: TODO se inyecta. Es la ÚNICA
// autoridad de: cuántos reintentos hace una ficha, cuánto se espera antes de cada
// reintento, y cuándo el budget global de sleep 429 se agota. NO decide QUÉ URL se
// navega (eso es identidad/navegación, §10) ni aborta el batch (§13): sólo calcula
// la política de espera y el veredicto de agotamiento.
//
// Contrato congelado (§11-§13, no modificar sin gate):
//   MAX_429_RETRIES = 3                      → 1 request inicial + ≤3 reintentos = ≤4 requests
//   FALLBACK_429_DELAYS_MS = [1000,2000,4000]
//   MAX_SINGLE_429_DELAY_MS = 30000
//   WALK_429_SLEEP_BUDGET_MS = 120000        → SÓLO cuenta sleep agregado por 429

export const MAX_429_RETRIES = 3;
export const MAX_SINGLE_429_DELAY_MS = 30000;
export const WALK_429_SLEEP_BUDGET_MS = 120000;
/** Fallback pre-registrado (§11). Índice = (reintento 1-based) − 1. NO modificar sin nuevo gate. */
export const FALLBACK_429_DELAYS_MS: readonly number[] = [1000, 2000, 4000];

/**
 * Parseo de Retry-After (§12): soporta delta-seconds y HTTP-date. `nowMs` se inyecta
 * (nunca Date.now interno) para que el cálculo del HTTP-date sea determinístico/testeable.
 *   - delta-seconds: entero no negativo → segundos*1000.
 *   - HTTP-date: fecha absoluta parseable → max(0, fecha − nowMs).
 *   - ausente/vacío/no parseable → null (el caller usa fallback).
 */
export function parseRetryAfterMs(headerValue: string | null | undefined, nowMs: number): number | null {
  if (headerValue == null) return null;
  const s = String(headerValue).trim();
  if (s === "") return null;
  if (/^\d+$/.test(s)) {
    const secs = Number(s);
    if (!Number.isFinite(secs) || secs < 0) return null;
    return secs * 1000;
  }
  const t = Date.parse(s);
  if (!Number.isFinite(t)) return null;
  const delta = t - nowMs;
  return delta > 0 ? delta : 0;
}

export interface Delay429Decision {
  /** Delay a aplicar realmente (ya capeado). Sólo válido si exceedsBudget=false. */
  appliedDelayMs: number;
  /** Retry-After venía > MAX_SINGLE_429_DELAY_MS y fue capeado a 30000. */
  capped: boolean;
  /** El delay deseado no cabe en el budget restante → el caller marca RATE_LIMITED. */
  exceedsBudget: boolean;
  /** Había Retry-After válido (para observabilidad). */
  retryAfterPresent: boolean;
}

/**
 * Calcula el delay del reintento `attempt` (1-based: primer reintento = attempt 1).
 *   - Con Retry-After válido (retryAfterMs != null): se usa ese valor, capeado a 30000.
 *   - Sin Retry-After: fallback pre-registrado por índice (1→1000, 2→2000, 3→4000; se
 *     satura en el último para attempts fuera de rango, defensivo).
 *   - Si appliedDelayMs > remainingBudgetMs → exceedsBudget=true: NO se debe dormir; el
 *     caller marca exhaustion → RATE_LIMITED (§13). El cap se aplica ANTES del chequeo de
 *     budget, de modo que un Retry-After gigante capeado a 30s puede sí caber en el budget.
 */
export function compute429Delay(input: {
  attempt: number;
  retryAfterMs: number | null;
  remainingBudgetMs: number;
}): Delay429Decision {
  const retryAfterPresent = input.retryAfterMs != null;
  let desired: number;
  let capped = false;
  if (input.retryAfterMs != null) {
    desired = input.retryAfterMs;
    if (desired > MAX_SINGLE_429_DELAY_MS) {
      desired = MAX_SINGLE_429_DELAY_MS;
      capped = true;
    }
  } else {
    const clamped = Math.min(Math.max(Math.trunc(input.attempt), 1), FALLBACK_429_DELAYS_MS.length);
    desired = FALLBACK_429_DELAYS_MS[clamped - 1];
  }
  const exceedsBudget = desired > input.remainingBudgetMs;
  return { appliedDelayMs: desired, capped, exceedsBudget, retryAfterPresent };
}
