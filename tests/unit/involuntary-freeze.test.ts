// TDD — predicado compartido de "freeze involuntario" de finalPrice.
//
// Misma definición que usa el cleanup (cleanup-stale-finalprices.ts) para no
// divergir: finalPrice set, wholesale set, sin manualMargin, sin manualSourceNote,
// sourceType SCRAPED|IMPORTED. El importador y el cleanup comparten esta fuente.

import { describe, it, expect } from "vitest";
import {
  isInvoluntaryFreeze,
  INVOLUNTARY_FREEZE_WHERE,
  type FreezeSignals,
} from "@/lib/catalog/involuntary-freeze";

const base: FreezeSignals = {
  finalPrice: 8256,
  wholesalePrice: 5000,
  manualMargin: null,
  manualSourceNote: null,
  sourceType: "IMPORTED",
};

describe("isInvoluntaryFreeze", () => {
  it("matchea el caso del cleanup (finalPrice involuntario)", () => {
    expect(isInvoluntaryFreeze(base)).toBe(true);
    expect(isInvoluntaryFreeze({ ...base, sourceType: "SCRAPED" })).toBe(true);
  });

  it("NO matchea si manualMargin existe (intención de margen)", () => {
    expect(isInvoluntaryFreeze({ ...base, manualMargin: 40 })).toBe(false);
  });

  it("NO matchea si manualSourceNote existe (precio manual intencional)", () => {
    expect(isInvoluntaryFreeze({ ...base, manualSourceNote: "precio promo" })).toBe(false);
  });

  it("NO matchea si finalPrice es null (no hay freeze)", () => {
    expect(isInvoluntaryFreeze({ ...base, finalPrice: null })).toBe(false);
  });

  it("NO matchea si wholesalePrice es null (manual sin costo)", () => {
    expect(isInvoluntaryFreeze({ ...base, wholesalePrice: null })).toBe(false);
  });

  it("NO matchea si sourceType no es SCRAPED/IMPORTED", () => {
    expect(isInvoluntaryFreeze({ ...base, sourceType: "MANUAL" })).toBe(false);
    expect(isInvoluntaryFreeze({ ...base, sourceType: "OWN" })).toBe(false);
  });
});

describe("INVOLUNTARY_FREEZE_WHERE — definición central para Prisma (la usa el cleanup)", () => {
  it("es el where exacto del criterio del cleanup", () => {
    expect(INVOLUNTARY_FREEZE_WHERE).toEqual({
      finalPrice: { not: null },
      wholesalePrice: { not: null },
      manualMargin: null,
      manualSourceNote: null,
      sourceType: { in: ["SCRAPED", "IMPORTED"] },
    });
  });
});
