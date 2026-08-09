// 2G-R8-Q2.1-B · §3.3 — COMPARE-AND-RESTORE guard. PURO. Construye el plan de restauración del estado
// comercial pre-run, FAIL-CLOSED: sólo restaura una fila si su estado ACTUAL todavía coincide con el
// estado que produjo LA corrida a deshacer (expectedPost). Si una fila cambió después por otra
// operación → CONFLICTO → el restore NO escribe nada (RESTORE_CONFLICT_POLICY=FAIL_CLOSED).
//
// RESTORE_SEMANTICS = COMMERCIAL_STATE_RESTORE_NOT_HISTORY_ERASURE: sólo revierte los campos mutados
// por Q2.1-B (wholesalePrice, lastSeenAt, latestExtractedProductId). NO borra ExtractionJob/EventLog/
// ExtractedProduct/witnesses.

export interface RestoreMutableRow {
  id: string;
  sku: string | null;
  wholesalePrice: number | null;
  lastSeenAt: string | null; // ISO
  latestExtractedProductId: string | null;
}

const mutableEqual = (a: RestoreMutableRow, b: RestoreMutableRow): boolean =>
  a.wholesalePrice === b.wholesalePrice &&
  a.lastSeenAt === b.lastSeenAt &&
  a.latestExtractedProductId === b.latestExtractedProductId;

export interface RestorePlanEntry {
  id: string;
  sku: string | null;
  to: { wholesalePrice: number | null; lastSeenAt: string | null; latestExtractedProductId: string | null };
}

export interface RestoreConflict {
  id: string;
  sku: string | null;
  reason: "CURRENT_STATE_DIVERGED_FROM_EXPECTED_POST_RUN";
}

export interface RestorePlan {
  rowsEvaluated: number;
  rowsWouldRestore: number;
  rowsAlreadyMatchingPreRun: number;
  conflicts: RestoreConflict[];
  conflictCount: number;
  fieldDiffCounts: { wholesalePrice: number; lastSeenAt: number; latestExtractedProductId: number };
  /** true SÓLO si no hay conflictos (fail-closed): recién entonces el script puede escribir el plan. */
  safe: boolean;
  plan: RestorePlanEntry[];
}

/**
 * `preRun` = estado deseado (a restaurar). `expectedPost` = estado que la corrida produjo en las filas
 * mutadas. `current` = estado actual de la DB. Se evalúa SÓLO el universo mutado (las filas de
 * expectedPost). Determinístico (salida ordenada por id).
 */
export function buildRestorePlan(args: {
  preRun: RestoreMutableRow[];
  expectedPost: RestoreMutableRow[];
  current: RestoreMutableRow[];
}): RestorePlan {
  const preById = new Map(args.preRun.map((r) => [r.id, r]));
  const curById = new Map(args.current.map((r) => [r.id, r]));

  const mutated = [...args.expectedPost].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const conflicts: RestoreConflict[] = [];
  const plan: RestorePlanEntry[] = [];
  let alreadyPreRun = 0;
  const fieldDiff = { wholesalePrice: 0, lastSeenAt: 0, latestExtractedProductId: 0 };

  for (const exp of mutated) {
    const cur = curById.get(exp.id);
    const pre = preById.get(exp.id);
    if (!cur || !pre) {
      // fila desaparecida o sin baseline → conflicto (no podemos restaurar con seguridad).
      conflicts.push({ id: exp.id, sku: exp.sku, reason: "CURRENT_STATE_DIVERGED_FROM_EXPECTED_POST_RUN" });
      continue;
    }
    if (mutableEqual(cur, pre)) {
      alreadyPreRun++; // ya está en el estado pre-run → nada que hacer
      continue;
    }
    if (!mutableEqual(cur, exp)) {
      // el estado actual NO es ni pre-run ni el esperado post-run → cambió por otra operación.
      conflicts.push({ id: exp.id, sku: exp.sku, reason: "CURRENT_STATE_DIVERGED_FROM_EXPECTED_POST_RUN" });
      continue;
    }
    // current == expectedPost → la corrida sigue intacta → restaurar a pre-run.
    if (cur.wholesalePrice !== pre.wholesalePrice) fieldDiff.wholesalePrice++;
    if (cur.lastSeenAt !== pre.lastSeenAt) fieldDiff.lastSeenAt++;
    if (cur.latestExtractedProductId !== pre.latestExtractedProductId) fieldDiff.latestExtractedProductId++;
    plan.push({ id: exp.id, sku: exp.sku, to: { wholesalePrice: pre.wholesalePrice, lastSeenAt: pre.lastSeenAt, latestExtractedProductId: pre.latestExtractedProductId } });
  }

  return {
    rowsEvaluated: mutated.length,
    rowsWouldRestore: plan.length,
    rowsAlreadyMatchingPreRun: alreadyPreRun,
    conflicts,
    conflictCount: conflicts.length,
    fieldDiffCounts: fieldDiff,
    safe: conflicts.length === 0,
    plan,
  };
}
