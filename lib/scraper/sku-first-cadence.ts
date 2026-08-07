export type ProductOutcome = "SUCCESS" | "ZERO_VARIANT" | "TERMINAL_FAILURE";

export interface ProductObservation {
  ordinal: number;
  elapsedMs: number;
  outcome: ProductOutcome;
}

export interface RunCadenceSummary {
  productsAttempted: number;
  successfulWithVariants: number;
  zeroVariantCount: number;
  terminalFailureCount: number;
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

/** Summarize a list of per-product observations into a RunCadenceSummary. */
export function summarizeCadence(observations: ProductObservation[]): RunCadenceSummary {
  const productsAttempted = observations.length;
  let successfulWithVariants = 0;
  let zeroVariantCount = 0;
  let terminalFailureCount = 0;
  const elapsed: number[] = [];

  for (const obs of observations) {
    switch (obs.outcome) {
      case "SUCCESS":
        successfulWithVariants += 1;
        break;
      case "ZERO_VARIANT":
        zeroVariantCount += 1;
        break;
      case "TERMINAL_FAILURE":
        terminalFailureCount += 1;
        break;
    }
    elapsed.push(obs.elapsedMs);
  }

  return {
    productsAttempted,
    successfulWithVariants,
    zeroVariantCount,
    terminalFailureCount,
    meanMsPerProduct: mean(elapsed),
    medianMsPerProduct: median(elapsed),
    p95MsPerProduct: percentileNearestRank(elapsed, 95),
    minMsPerProduct: elapsed.length === 0 ? 0 : Math.min(...elapsed),
    maxMsPerProduct: elapsed.length === 0 ? 0 : Math.max(...elapsed),
  };
}
