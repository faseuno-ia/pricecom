// 2G-R8-Q2.1-B · §8 — LIFECYCLE SHADOW. PURO. Cálculo SIN efectos: proyecta qué pausas/reactivaciones
// aplicaría un enforcement futuro, a partir de las particiones. NUNCA escribe (LIFECYCLE_SHADOW_WRITES=0).
// Se calcula en el paso 5 (antes de las compuertas) para que la proyección exista SIEMPRE, incluso si
// la corrida aborta. El ESTADO del preview (DIAGNOSTIC_ONLY / VALID_SHADOW*) lo fija el caller.

import type { PartitionResult } from "./partition-write-set";

/** Razones de UNVERIFIED que corresponden a una causa de proveedor con pausa propia. */
const PAUSE_DATA_INCOMPLETE = "DATA_INCOMPLETE";
const PAUSE_READ_FAILED = "READ_FAILED";
const PAUSE_RATE_LIMITED = "RATE_LIMITED";
const UNMAPPABLE_REASONS = new Set(["UNMAPPABLE_MAPPING", "AMBIGUOUS_MAPPING"]);

export interface LifecycleShadowResult {
  wouldPausePriceNotPublished: number;
  wouldPauseDataIncomplete: number;
  wouldPauseReadFailed: number;
  wouldPauseRateLimited: number;
  wouldPauseDelisted: number;
  wouldReactivate: number;
  unmappableCount: number;
  /** UNVERIFIED por razones que NO son causa de proveedor clara (evidence conflict, sitemap drift,
   *  variant/identity incompleto, not observed): "no entendidas", esperadas ~0 en una corrida sana. */
  unknownCount: number;
  /** Suma de las CINCO categorías de pausa (comparable con la predicción ≈50-56). */
  totalWouldPause: number;
  lifecycleShadowWrites: 0;
}

export function computeLifecycleShadow(partition: PartitionResult): LifecycleShadowResult {
  const byReason = partition.unverifiedCountByReason;
  const dataIncomplete = byReason[PAUSE_DATA_INCOMPLETE] ?? 0;
  const readFailed = byReason[PAUSE_READ_FAILED] ?? 0;
  const rateLimited = byReason[PAUSE_RATE_LIMITED] ?? 0;

  let unmappable = 0;
  let unknown = 0;
  for (const [reason, count] of Object.entries(byReason)) {
    if (reason === PAUSE_DATA_INCOMPLETE || reason === PAUSE_READ_FAILED || reason === PAUSE_RATE_LIMITED) continue;
    if (UNMAPPABLE_REASONS.has(reason)) unmappable += count;
    else unknown += count;
  }

  const priceNotPublished = partition.presentWithoutPriceCount;
  const delisted = partition.verifiedAbsentCount;
  const totalWouldPause = priceNotPublished + dataIncomplete + readFailed + rateLimited + delisted;

  return {
    wouldPausePriceNotPublished: priceNotPublished,
    wouldPauseDataIncomplete: dataIncomplete,
    wouldPauseReadFailed: readFailed,
    wouldPauseRateLimited: rateLimited,
    wouldPauseDelisted: delisted,
    wouldReactivate: 0, // no existe pausa automática previa (§Q2.1-F): NOT_EXERCISED, no es defecto
    unmappableCount: unmappable,
    unknownCount: unknown,
    totalWouldPause,
    lifecycleShadowWrites: 0,
  };
}
