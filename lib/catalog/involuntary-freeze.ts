// Definición ÚNICA de "freeze involuntario" de finalPrice: un precio congelado
// que el cliente nunca puso a mano, sino que entró por un import de Excel que
// mapeó una columna de precio de venta a finalPrice (foot-gun). El cleanup
// (scripts/cleanup-stale-finalprices.ts) y el importador comparten esta fuente
// para no divergir.
//
// Criterio: finalPrice set, wholesale set (hay costo → debería recalcularse),
// SIN manualMargin (no hay margen intencional), SIN manualSourceNote (no hay
// nota de carga manual intencional), y sourceType automático/importado.

import type { Prisma } from "@prisma/client";

export interface FreezeSignals {
  finalPrice: number | null;
  wholesalePrice: number | null;
  manualMargin: number | null;
  manualSourceNote: string | null;
  /** CatalogSourceType: "SCRAPED" | "IMPORTED" | "MANUAL" | "OWN" | ... */
  sourceType: string;
}

/** Predicado in-memory. Misma semántica que INVOLUNTARY_FREEZE_WHERE. */
export function isInvoluntaryFreeze(s: FreezeSignals): boolean {
  return (
    s.finalPrice != null &&
    s.wholesalePrice != null &&
    s.manualMargin == null &&
    s.manualSourceNote == null &&
    (s.sourceType === "SCRAPED" || s.sourceType === "IMPORTED")
  );
}

/** Mismo criterio como `where` de Prisma (para SELECT/UPDATE del cleanup). */
export const INVOLUNTARY_FREEZE_WHERE = {
  finalPrice: { not: null },
  wholesalePrice: { not: null },
  manualMargin: null,
  manualSourceNote: null,
  sourceType: { in: ["SCRAPED", "IMPORTED"] },
} as const satisfies Prisma.CatalogProductWhereInput;
