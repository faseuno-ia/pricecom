// G1 — Adapter PURO de dos snapshots (START/END) para la completitud SKU-first.
//
// Autoridad de completitud (firmada): COBERTURA de la referencia estable con un PISO absoluto.
//   WALK_COMPLETENESS_AUTHORITY = STABLE_REFERENCE_COVERAGE_WITH_ABSOLUTE_MINIMUM
// El `walkStatus` NO se deriva de la terminación de paginación (ambigua): se PROYECTA desde la
// cobertura (COVERAGE_COMPLETE ? COMPLETE : PARTIAL). Envuelve `resolveSitemapCompletenessOutcome`
// SIN cambiar su firma ni su semántica histórica.
//
// Precedencia de estados (G1M-E2 + piso mínimo):
//   1. FETCH_FAILED (start/end)          → fail-closed ANTES del resolver.
//   2. snapshot EXPLICITLY_EMPTY          → resolver (PARTIAL/exit23/R2_SITEMAP_REFERENCE_EXPLICITLY_EMPTY).
//   3. ambos poblados, intersección ∅     → R2_SITEMAP_STABLE_INTERSECTION_EMPTY (PROPIA, no empty).
//   4. 0 < BLOCKING < minExpectedProducts → R2_SITEMAP_REFERENCE_IMPLAUSIBLY_SMALL (PROPIA).
//   5. BLOCKING ≥ min, cobertura incompleta → PARTIAL (fail-closed).
//   6. BLOCKING ≥ min, cobertura total      → COMPLETE.
import { createHash } from "node:crypto";
import { resolveSitemapCompletenessOutcome } from "./sitemap-completeness";
import type { SitemapSnapshot } from "./runtime-sitemap-reference";

const SAMPLE_MAX = 20;
const sortedSample = (arr: string[]): string[] => [...arr].sort().slice(0, SAMPLE_MAX);
const setSha = (arr: string[]): string => createHash("sha256").update([...arr].sort().join("\n")).digest("hex");

export interface TwoSnapshotInput {
  start: SitemapSnapshot;
  end: SitemapSnapshot;
  /** URLs normalizadas de fichas capturadas y ACEPTADAS por el walk. */
  walkSet: string[];
  /** Piso absoluto de fichas estables plausibles (Different Touch: 700). */
  minExpectedProducts: number;
}

export interface TwoSnapshotDiagnostics {
  sitemapStartCount: number;
  sitemapEndCount: number;
  blockingSetCount: number;
  walkSetCount: number;
  minExpectedProducts: number;
  addedDuringRunCount: number;
  removedDuringRunCount: number;
  blockingMissingCount: number;
  walkOnlyOutsideStartEndCount: number;
  startSetSha256: string | null;
  endSetSha256: string | null;
  blockingSetSha256: string | null;
  blockingMissingSetSha256: string | null;
  blockingMissingSample: string[];
  addedDuringRunSample: string[];
  removedDuringRunSample: string[];
}

export type TwoSnapshotResult =
  | { complete: true; reasonCode: null; failedBeforeResolver: false; diagnostics: TwoSnapshotDiagnostics }
  | { complete: false; reasonCode: string; failedBeforeResolver: boolean; diagnostics: TwoSnapshotDiagnostics };

function diagOf(
  startUrls: string[], endUrls: string[], walkSet: string[], minExpectedProducts: number,
  extra?: Partial<TwoSnapshotDiagnostics>,
): TwoSnapshotDiagnostics {
  return {
    sitemapStartCount: startUrls.length,
    sitemapEndCount: endUrls.length,
    blockingSetCount: 0,
    walkSetCount: new Set(walkSet).size,
    minExpectedProducts,
    addedDuringRunCount: 0,
    removedDuringRunCount: 0,
    blockingMissingCount: 0,
    walkOnlyOutsideStartEndCount: 0,
    startSetSha256: startUrls.length ? setSha(startUrls) : null,
    endSetSha256: endUrls.length ? setSha(endUrls) : null,
    blockingSetSha256: null,
    blockingMissingSetSha256: null,
    blockingMissingSample: [],
    addedDuringRunSample: [],
    removedDuringRunSample: [],
    ...extra,
  };
}

/**
 * Resuelve la completitud por cobertura de la referencia estable con piso absoluto.
 * `complete=true` habilita la persistencia; todo lo demás es fail-closed.
 */
export function resolveTwoSnapshotCompleteness(input: TwoSnapshotInput): TwoSnapshotResult {
  const { start, end, walkSet, minExpectedProducts } = input;

  // 1 · fallos pre-resolver
  if (start.kind === "FETCH_FAILED") {
    return { complete: false, reasonCode: "R2_SITEMAP_START_FETCH_FAILED_" + start.reason, failedBeforeResolver: true, diagnostics: diagOf([], [], walkSet, minExpectedProducts) };
  }
  if (end.kind === "FETCH_FAILED") {
    const su = start.kind === "POPULATED" ? start.urls : [];
    return { complete: false, reasonCode: "R2_SITEMAP_END_FETCH_FAILED_" + end.reason, failedBeforeResolver: true, diagnostics: diagOf(su, [], walkSet, minExpectedProducts) };
  }

  const startUrls = start.kind === "POPULATED" ? start.urls : [];
  const endUrls = end.kind === "POPULATED" ? end.urls : [];

  // 2 · snapshot explícitamente vacío → autoridad histórica (PARTIAL/exit23)
  if (start.kind === "EXPLICITLY_EMPTY" || end.kind === "EXPLICITLY_EMPTY") {
    // walkStatus="COMPLETE" para que el resolver aflore EXPLICITLY_EMPTY (su precedencia chequea
    // walkStatus antes que referenceKind); el resultado igual es complete=false → fail-closed.
    const outcome = resolveSitemapCompletenessOutcome({
      walkStatus: "COMPLETE", referenceKind: "EXPLICITLY_EMPTY_REFERENCE", normalizedReferenceCount: 0, exactSetMatch: false,
    });
    return { complete: false, reasonCode: outcome.reasonCode ?? "R2_SITEMAP_REFERENCE_EXPLICITLY_EMPTY", failedBeforeResolver: false, diagnostics: diagOf(startUrls, endUrls, walkSet, minExpectedProducts) };
  }

  // ambos poblados
  const startSet = new Set(startUrls);
  const endSet = new Set(endUrls);
  const walk = new Set(walkSet);
  const blocking = [...startSet].filter((u) => endSet.has(u));
  const added = [...endSet].filter((u) => !startSet.has(u));
  const removed = [...startSet].filter((u) => !endSet.has(u));
  const blockingSet = new Set(blocking);
  const blockingMissing = blocking.filter((u) => !walk.has(u));
  const walkOnlyOutside = [...walk].filter((u) => !startSet.has(u) && !endSet.has(u));

  const diagnostics: TwoSnapshotDiagnostics = {
    sitemapStartCount: startUrls.length,
    sitemapEndCount: endUrls.length,
    blockingSetCount: blockingSet.size,
    walkSetCount: walk.size,
    minExpectedProducts,
    addedDuringRunCount: added.length,
    removedDuringRunCount: removed.length,
    blockingMissingCount: blockingMissing.length,
    walkOnlyOutsideStartEndCount: walkOnlyOutside.length,
    startSetSha256: setSha(startUrls),
    endSetSha256: setSha(endUrls),
    blockingSetSha256: blocking.length ? setSha(blocking) : null,
    blockingMissingSetSha256: blockingMissing.length ? setSha(blockingMissing) : null,
    blockingMissingSample: sortedSample(blockingMissing),
    addedDuringRunSample: sortedSample(added),
    removedDuringRunSample: sortedSample(removed),
  };

  // 3 · intersección estable vacía (ambos poblados) → reason PROPIA, pre-resolver
  if (blockingSet.size === 0) {
    return { complete: false, reasonCode: "R2_SITEMAP_STABLE_INTERSECTION_EMPTY", failedBeforeResolver: true, diagnostics };
  }
  // 4 · intersección implausiblemente pequeña → reason PROPIA, pre-resolver
  if (blockingSet.size < minExpectedProducts) {
    return { complete: false, reasonCode: "R2_SITEMAP_REFERENCE_IMPLAUSIBLY_SMALL", failedBeforeResolver: true, diagnostics };
  }

  // 5/6 · referencia suficiente: la cobertura proyecta el walkStatus.
  const coverageComplete = blockingMissing.length === 0;
  const exactSetMatch = coverageComplete;
  const resolverWalkStatus = coverageComplete ? "COMPLETE" : "PARTIAL";
  const outcome = resolveSitemapCompletenessOutcome({
    walkStatus: resolverWalkStatus,
    referenceKind: "POPULATED_REFERENCE",
    normalizedReferenceCount: blockingSet.size,
    exactSetMatch,
  });
  if (outcome.complete) {
    return { complete: true, reasonCode: null, failedBeforeResolver: false, diagnostics };
  }
  return { complete: false, reasonCode: outcome.reasonCode ?? "R2_SITEMAP_INCOMPLETE", failedBeforeResolver: false, diagnostics };
}
