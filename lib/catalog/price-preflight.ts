// 2G-R8-Q2.1-B · §6 — PRICE PREFLIGHT. PURO. Evalúa la plausibilidad de los cambios de precio
// ANTES de abrir la transacción. Opera EXCLUSIVAMENTE sobre el PRICE_WRITE_SET (prefijo WRITESET_
// para los hard-fails de escritura). Los SKU_PRESENT_WITHOUT_PRICE NO cuentan como NEW_NULL: se
// reportan aparte (§6.1) — sin esta separación, los 47 nulls dispararían un abort espurio.
//
// Precios ABSOLUTOS en las muestras están AUTORIZADOS (§6.2: son precios del proveedor, no
// credenciales). El módulo NO imprime; devuelve las muestras y el caller decide.

import type { PriceWriteEntry } from "./partition-write-set";

export type PriceChangeShape = "NORMAL_DRIFT" | "SYSTEMATIC_REBASE" | "INCOHERENT" | "NO_CHANGE";
export type PricePlausibilityVerdict = "PASS" | "REVIEW_REQUIRED" | "ABORT";

export const MEDIAN_RELATIVE_PRICE_CHANGE_REVIEW_THRESHOLD = 0.25;
/** Un cambio con ratio new/old >= 10 o <= 0.1 es un salto de orden de magnitud (hard-fail). */
export const ORDER_OF_MAGNITUDE_RATIO = 10;

export interface PriceChangeSampleEntry { sku: string; old: number; new: number; rel: number }

export interface PricePreflightResult {
  // hard-fails de escritura (deben ser 0 POR CONSTRUCCIÓN del write-set):
  writesetExistingPricedToNullCount: number;
  writesetNewNullPriceCount: number;
  writesetNewNonpositivePriceCount: number;
  priceWriteSetConstructionBug: boolean;
  // métricas sobre old>0 AND new>0:
  wholesalePriceChangedCount: number;
  medianRelativePriceChange: number;
  p95AbsRelativePriceChange: number;
  iqrRelativePriceChange: number;
  shareWithin5pctOfMedianChange: number;
  shareNegativeChange: number;
  sharePositiveChange: number;
  rowsChangedMoreThan50Pct: number;
  rowsChangedMoreThan200Pct: number;
  priceOrderOfMagnitudeShiftCount: number;
  // fuera del ratio:
  nullToValidPriceCount: number;
  presentWithoutPriceCount: number;
  // muestras (precios absolutos autorizados):
  priceChangeSampleMax20: PriceChangeSampleEntry[];
  top5OutliersByAbsRelChange: PriceChangeSampleEntry[];
  // forma + veredicto:
  shape: PriceChangeShape;
  verdict: PricePlausibilityVerdict;
  abortReasons: string[];
}

function percentile(sortedAsc: number[], p: number): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  if (n === 1) return sortedAsc[0];
  const rank = (p / 100) * (n - 1);
  const lo = Math.floor(rank), hi = Math.ceil(rank);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (rank - lo);
}
function median(sortedAsc: number[]): number {
  const n = sortedAsc.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 ? sortedAsc[mid] : (sortedAsc[mid - 1] + sortedAsc[mid]) / 2;
}

export interface PricePreflightInput {
  priceWriteSet: PriceWriteEntry[];
  presentWithoutPriceCount: number;
}

export function evaluatePricePreflight(input: PricePreflightInput): PricePreflightResult {
  const ws = input.priceWriteSet;

  // ── hard-fails de escritura (defensivos; 0 por construcción del write-set) ──
  let existingPricedToNull = 0, newNull = 0, newNonpositive = 0;
  for (const e of ws) {
    if (e.newPrice == null || Number.isNaN(e.newPrice)) newNull++;
    else if (!(e.newPrice > 0) || !Number.isFinite(e.newPrice)) newNonpositive++;
    if (typeof e.oldPrice === "number" && e.oldPrice > 0 && (e.newPrice == null || Number.isNaN(e.newPrice))) existingPricedToNull++;
  }

  // ── universo del ratio: old>0 AND new>0 ──
  const changes: PriceChangeSampleEntry[] = [];
  let nullToValid = 0;
  for (const e of ws) {
    const oldOk = typeof e.oldPrice === "number" && e.oldPrice > 0 && Number.isFinite(e.oldPrice);
    const newOk = typeof e.newPrice === "number" && e.newPrice > 0 && Number.isFinite(e.newPrice);
    if (oldOk && newOk) {
      const rel = (e.newPrice - (e.oldPrice as number)) / (e.oldPrice as number);
      changes.push({ sku: e.sku, old: e.oldPrice as number, new: e.newPrice, rel });
    } else if (!oldOk && newOk) {
      nullToValid++;
    }
  }

  const changed = changes.filter((c) => c.rel !== 0);
  const rels = changed.map((c) => c.rel);
  const relsSorted = [...rels].sort((a, b) => a - b);
  const absRelsSorted = [...rels].map(Math.abs).sort((a, b) => a - b);
  const med = median(relsSorted);
  const p95Abs = percentile(absRelsSorted, 95);
  const q1 = percentile(relsSorted, 25), q3 = percentile(relsSorted, 75);
  const iqr = q3 - q1;
  const within5 = rels.filter((r) => Math.abs(r - med) <= 0.05).length;
  const shareWithin5 = rels.length ? within5 / rels.length : 0;
  const neg = rels.filter((r) => r < 0).length;
  const pos = rels.filter((r) => r > 0).length;
  const gt50 = rels.filter((r) => Math.abs(r) > 0.5).length;
  const gt200 = rels.filter((r) => Math.abs(r) > 2.0).length;
  const orderOfMag = changes.filter((c) => c.new / c.old >= ORDER_OF_MAGNITUDE_RATIO || c.new / c.old <= 1 / ORDER_OF_MAGNITUDE_RATIO).length;

  const top5 = [...changes].sort((a, b) => Math.abs(b.rel) - Math.abs(a.rel)).slice(0, 5);
  const sample20 = changes.slice(0, 20);

  // ── forma (§6.5) ──
  let shape: PriceChangeShape;
  if (changed.length === 0) shape = "NO_CHANGE";
  else if (shareWithin5 >= 0.8 && Math.abs(med) > 0.05) shape = "SYSTEMATIC_REBASE";
  else if (shareWithin5 < 0.5) shape = "INCOHERENT";
  else shape = "NORMAL_DRIFT";

  // ── veredicto ──
  const construction = existingPricedToNull > 0 || newNull > 0 || newNonpositive > 0;
  const abortReasons: string[] = [];
  if (orderOfMag > 0) abortReasons.push(`PRICE_ORDER_OF_MAGNITUDE_SHIFT_COUNT=${orderOfMag}`);
  if (existingPricedToNull > 0) abortReasons.push(`WRITESET_EXISTING_PRICED_TO_NULL_COUNT=${existingPricedToNull}`);
  if (newNull > 0) abortReasons.push(`WRITESET_NEW_NULL_PRICE_COUNT=${newNull}`);
  if (newNonpositive > 0) abortReasons.push(`WRITESET_NEW_NONPOSITIVE_PRICE_COUNT=${newNonpositive}`);

  let verdict: PricePlausibilityVerdict;
  if (abortReasons.length > 0) verdict = "ABORT";
  else if (Math.abs(med) > MEDIAN_RELATIVE_PRICE_CHANGE_REVIEW_THRESHOLD || shape === "INCOHERENT") verdict = "REVIEW_REQUIRED";
  else verdict = "PASS";

  return {
    writesetExistingPricedToNullCount: existingPricedToNull,
    writesetNewNullPriceCount: newNull,
    writesetNewNonpositivePriceCount: newNonpositive,
    priceWriteSetConstructionBug: construction,
    wholesalePriceChangedCount: changed.length,
    medianRelativePriceChange: med,
    p95AbsRelativePriceChange: p95Abs,
    iqrRelativePriceChange: iqr,
    shareWithin5pctOfMedianChange: shareWithin5,
    shareNegativeChange: rels.length ? neg / rels.length : 0,
    sharePositiveChange: rels.length ? pos / rels.length : 0,
    rowsChangedMoreThan50Pct: gt50,
    rowsChangedMoreThan200Pct: gt200,
    priceOrderOfMagnitudeShiftCount: orderOfMag,
    nullToValidPriceCount: nullToValid,
    presentWithoutPriceCount: input.presentWithoutPriceCount,
    priceChangeSampleMax20: sample20,
    top5OutliersByAbsRelChange: top5,
    shape,
    verdict,
    abortReasons,
  };
}
