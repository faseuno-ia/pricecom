import { describe, it, expect } from "vitest";
import {
  percentileNearestRank,
  mean,
  median,
  summarizeCadence,
  type ProductObservation,
} from "../../lib/scraper/sku-first-cadence";

describe("percentileNearestRank", () => {
  it("returns 0 for empty array", () => {
    expect(percentileNearestRank([], 95)).toBe(0);
    expect(percentileNearestRank([], 0)).toBe(0);
    expect(percentileNearestRank([], 100)).toBe(0);
  });

  it("returns the single element regardless of p", () => {
    expect(percentileNearestRank([42], 0)).toBe(42);
    expect(percentileNearestRank([42], 50)).toBe(42);
    expect(percentileNearestRank([42], 95)).toBe(42);
    expect(percentileNearestRank([42], 100)).toBe(42);
  });

  it("computes p95 of 1..100 as 95 (nearest-rank)", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    // rank = ceil(0.95 * 100) = 95 -> sorted[94] = 95
    expect(percentileNearestRank(values, 95)).toBe(95);
  });

  it("computes p100 as the max", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentileNearestRank(values, 100)).toBe(100);
  });

  it("computes p0 and p1 edge as the first element", () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    // p0: rank = ceil(0) = 0 -> clamped to 1 -> sorted[0] = 1
    expect(percentileNearestRank(values, 0)).toBe(1);
    // p1: rank = ceil(0.01 * 100) = 1 -> sorted[0] = 1
    expect(percentileNearestRank(values, 1)).toBe(1);
  });

  it("hand-computed on a small unsorted array", () => {
    const values = [50, 10, 40, 20, 30]; // sorted: 10,20,30,40,50 (n=5)
    // p50: rank = ceil(0.5*5) = ceil(2.5) = 3 -> sorted[2] = 30
    expect(percentileNearestRank(values, 50)).toBe(30);
    // p95: rank = ceil(0.95*5) = ceil(4.75) = 5 -> sorted[4] = 50
    expect(percentileNearestRank(values, 95)).toBe(50);
    // p20: rank = ceil(0.2*5) = 1 -> sorted[0] = 10
    expect(percentileNearestRank(values, 20)).toBe(10);
    // p40: rank = ceil(0.4*5) = 2 -> sorted[1] = 20
    expect(percentileNearestRank(values, 40)).toBe(20);
  });
});

describe("mean", () => {
  it("returns 0 for empty array", () => {
    expect(mean([])).toBe(0);
  });

  it("computes a simple mean", () => {
    expect(mean([2, 4, 6])).toBe(4);
    expect(mean([10])).toBe(10);
    expect(mean([1, 2])).toBe(1.5);
  });
});

describe("median", () => {
  it("returns 0 for empty array", () => {
    expect(median([])).toBe(0);
  });

  it("computes median for odd length", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([5])).toBe(5);
  });

  it("computes median for even length as average of two middles", () => {
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([10, 20])).toBe(15);
  });
});

describe("summarizeCadence (2G-R8-Q2 · taxonomía 4-outcome)", () => {
  it("handles 0 samples with all zeros and zero counts", () => {
    const summary = summarizeCadence([]);
    expect(summary).toEqual({
      productsAttempted: 0,
      verifiedOk: 0,
      dataIncomplete: 0,
      rateLimited: 0,
      readFailed: 0,
      recoveredAfter429: 0,
      meanMsPerProduct: 0,
      medianMsPerProduct: 0,
      p95MsPerProduct: 0,
      minMsPerProduct: 0,
      maxMsPerProduct: 0,
    });
  });

  it("handles a single sample", () => {
    const obs: ProductObservation[] = [
      { ordinal: 1, elapsedMs: 250, outcome: "VERIFIED_OK" },
    ];
    const summary = summarizeCadence(obs);
    expect(summary).toEqual({
      productsAttempted: 1,
      verifiedOk: 1,
      dataIncomplete: 0,
      rateLimited: 0,
      readFailed: 0,
      recoveredAfter429: 0,
      meanMsPerProduct: 250,
      medianMsPerProduct: 250,
      p95MsPerProduct: 250,
      minMsPerProduct: 250,
      maxMsPerProduct: 250,
    });
  });

  it("counts the four outcomes SEPARATELY (§14: no condensar bajo 'sin variantes') y stats sobre TODAS", () => {
    const obs: ProductObservation[] = [
      { ordinal: 1, elapsedMs: 100, outcome: "VERIFIED_OK" },
      { ordinal: 2, elapsedMs: 200, outcome: "DATA_INCOMPLETE" },
      { ordinal: 3, elapsedMs: 300, outcome: "READ_FAILED" },
      { ordinal: 4, elapsedMs: 400, outcome: "RATE_LIMITED" },
      { ordinal: 5, elapsedMs: 500, outcome: "VERIFIED_OK", recoveredAfter429: true },
    ];
    const summary = summarizeCadence(obs);
    expect(summary.productsAttempted).toBe(5);
    expect(summary.verifiedOk).toBe(2);
    expect(summary.dataIncomplete).toBe(1);
    expect(summary.rateLimited).toBe(1);
    expect(summary.readFailed).toBe(1);
    expect(summary.recoveredAfter429).toBe(1);
    // stats over all 5 elapsedMs: 100,200,300,400,500
    expect(summary.meanMsPerProduct).toBe(300);
    expect(summary.medianMsPerProduct).toBe(300);
    expect(summary.minMsPerProduct).toBe(100);
    expect(summary.maxMsPerProduct).toBe(500);
    // p95: rank = ceil(0.95*5) = 5 -> sorted[4] = 500
    expect(summary.p95MsPerProduct).toBe(500);
  });

  it("RATE_LIMITED y DATA_INCOMPLETE NO se cuentan como el mismo outcome", () => {
    const obs: ProductObservation[] = [
      { ordinal: 1, elapsedMs: 10, outcome: "RATE_LIMITED" },
      { ordinal: 2, elapsedMs: 30, outcome: "DATA_INCOMPLETE" },
      { ordinal: 3, elapsedMs: 20, outcome: "RATE_LIMITED" },
    ];
    const summary = summarizeCadence(obs);
    expect(summary.rateLimited).toBe(2);
    expect(summary.dataIncomplete).toBe(1);
    expect(summary.verifiedOk).toBe(0);
    expect(summary.readFailed).toBe(0);
    expect(summary.meanMsPerProduct).toBe(20);
    expect(summary.minMsPerProduct).toBe(10);
    expect(summary.maxMsPerProduct).toBe(30);
  });

  it("fichas READ_FAILED no se excluyen de los stats de timing", () => {
    // Si se excluyeran, la media sería 100 (solo el VERIFIED_OK). Incluyendo todas: media [100,900]=500.
    const obs: ProductObservation[] = [
      { ordinal: 1, elapsedMs: 100, outcome: "VERIFIED_OK" },
      { ordinal: 2, elapsedMs: 900, outcome: "READ_FAILED" },
    ];
    const summary = summarizeCadence(obs);
    expect(summary.meanMsPerProduct).toBe(500);
    expect(summary.maxMsPerProduct).toBe(900);
  });
});
