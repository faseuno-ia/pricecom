// 2G-R8-Q2 · Resumen de cadencia con la taxonomía de outcome de ficha (§14).
// Los cuatro outcomes NO se condensan bajo "sin variantes": VERIFIED_OK,
// DATA_INCOMPLETE, RATE_LIMITED y READ_FAILED se cuentan por separado, más el
// nº de fichas recuperadas tras 429 y el sleep 429 agregado del walk.
import type { FichaCaptureOutcome } from "./tiendanube-walker";

export type ProductOutcome = FichaCaptureOutcome;

export interface ProductObservation {
  ordinal: number;
  elapsedMs: number;
  outcome: FichaCaptureOutcome;
  recoveredAfter429?: boolean;
}

export interface RunCadenceSummary {
  productsAttempted: number;
  verifiedOk: number;
  dataIncomplete: number;
  rateLimited: number;
  readFailed: number;
  recoveredAfter429: number;
  meanMsPerProduct: number; // 0 when no samples
  medianMsPerProduct: number; // 0 when no samples
  p95MsPerProduct: number; // nearest-rank p95; 0 when no samples
  minMsPerProduct: number; // 0 when no samples
  maxMsPerProduct: number; // 0 when no samples
}

/** Nearest-rank percentile. p in [0,100]. Empty -> 0. rank = ceil(p/100 * n), clamped to [1,n]. */
export function percentileNearestRank(values: number[], p: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  let rank = Math.ceil((p / 100) * n);
  if (rank < 1) rank = 1;
  if (rank > n) rank = n;
  return sorted[rank - 1];
}

export function mean(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / n;
}

export function median(values: number[]): number {
  const n = values.length;
  if (n === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(n / 2);
  if (n % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Summarize a list of per-product observations into a RunCadenceSummary (§14 taxonomy). */
export function summarizeCadence(observations: ProductObservation[]): RunCadenceSummary {
  const productsAttempted = observations.length;
  let verifiedOk = 0;
  let dataIncomplete = 0;
  let rateLimited = 0;
  let readFailed = 0;
  let recoveredAfter429 = 0;
  const elapsed: number[] = [];

  for (const obs of observations) {
    switch (obs.outcome) {
      case "VERIFIED_OK": verifiedOk += 1; break;
      case "DATA_INCOMPLETE": dataIncomplete += 1; break;
      case "RATE_LIMITED": rateLimited += 1; break;
      case "READ_FAILED": readFailed += 1; break;
    }
    if (obs.recoveredAfter429) recoveredAfter429 += 1;
    elapsed.push(obs.elapsedMs);
  }

  return {
    productsAttempted,
    verifiedOk,
    dataIncomplete,
    rateLimited,
    readFailed,
    recoveredAfter429,
    meanMsPerProduct: mean(elapsed),
    medianMsPerProduct: median(elapsed),
    p95MsPerProduct: percentileNearestRank(elapsed, 95),
    minMsPerProduct: elapsed.length === 0 ? 0 : Math.min(...elapsed),
    maxMsPerProduct: elapsed.length === 0 ? 0 : Math.max(...elapsed),
  };
}
