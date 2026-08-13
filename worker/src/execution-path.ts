// 2G-R9-PR2 · UNA SOLA decisión canónica de path por job + guard estructural del canary.
//
// decideExecutionPath es PURA y es la ÚNICA evaluación de selección de path. processJob la consume y no
// re-evalúa nada. Un job de canary (source === CANARY_MARKER) NUNCA puede caer al historical path: si las
// precondiciones del partial (C1∧C2∧C3) no se cumplen, la decisión es CANARY_FAIL_CLOSED y el worker
// lanza un error tipado ANTES del scraper (terminalización fenced vía el catch existente de processJob).

import type { WorkerIdentity } from "./worker-boot";

/** El marcador de canary vive en ExtractionJob.source. Autoridad INTERNAL_ONLY (ninguna API/UI/scheduler
 *  puede fijar source; el enqueue público whitelistea sólo providerId+startUrl). Ver docs. */
export const CANARY_MARKER = "CANARY_PARTIAL";
export const PATH_DECISION_SCHEMA_VERSION = 1 as const;

/** errorMessage estable de la terminalización fail-closed del canary (distinguible del persist error). */
export const CANARY_PRECONDITION_ERROR_CODE = "CONTROLLED_CANARY_PARTIAL_PRECONDITION_FAILED";
/** errorMessage estable cuando el witness durable del canary no se pudo persistir antes del scraper. */
export const CANARY_WITNESS_PERSIST_ERROR_CODE = "CONTROLLED_CANARY_PATH_DECISION_PERSIST_FAILED";

const PRICE_ONLY = "PRICE_ONLY";
const SKU_FIRST = "TIENDANUBE_LS_VARIANTS_SKU_FIRST";

export type ExecutionPath = "PARTIAL" | "HISTORICAL" | "CANARY_FAIL_CLOSED";

export interface PathDecisionInput {
  isCanary: boolean;
  partialFlagEnabled: boolean;                 // C1 · PARTIAL_COMMIT_SHADOW === "1"
  catalogWriteMode: string | null | undefined; // C2 · resuelto ("PRICE_ONLY" | "FULL")
  extractionMode: string | null | undefined;   // C3 · effectiveExtractionMode
}

export interface PathDecision {
  selectedPath: ExecutionPath;
  /** subconjunto ordenado de ["C1","C2","C3"] con los conjuncts que fallaron (todos los falsos). */
  failedConjuncts: string[];
}

/**
 * ÚNICA evaluación de path. Determinística. failedConjuncts reporta TODOS los conjuncts falsos en orden
 * C1,C2,C3. PARTIAL sólo si los tres se cumplen; si no, HISTORICAL para jobs normales y CANARY_FAIL_CLOSED
 * para jobs de canary (que NUNCA deben ejecutar el historical path).
 */
export function decideExecutionPath(input: PathDecisionInput): PathDecision {
  const c1 = input.partialFlagEnabled === true;
  const c2 = input.catalogWriteMode === PRICE_ONLY;
  const c3 = input.extractionMode === SKU_FIRST;

  const failedConjuncts: string[] = [];
  if (!c1) failedConjuncts.push("C1");
  if (!c2) failedConjuncts.push("C2");
  if (!c3) failedConjuncts.push("C3");

  if (c1 && c2 && c3) return { selectedPath: "PARTIAL", failedConjuncts: [] };
  if (input.isCanary) return { selectedPath: "CANARY_FAIL_CLOSED", failedConjuncts };
  return { selectedPath: "HISTORICAL", failedConjuncts };
}

/** Error tipado del canary fail-closed. Su .message estable llega a markFailed vía selectFailureMessage. */
export class CanaryPreconditionError extends Error {
  readonly reasonCode = CANARY_PRECONDITION_ERROR_CODE;
  readonly failedConjuncts: string[];
  constructor(failedConjuncts: string[]) {
    super(`${CANARY_PRECONDITION_ERROR_CODE} failedConjuncts=[${failedConjuncts.join(",")}]`);
    this.name = "CanaryPreconditionError";
    this.failedConjuncts = failedConjuncts;
  }
}

/** El witness durable del canary no se pudo persistir → fail-closed ANTES del scraper (razón distinguible). */
export class CanaryWitnessPersistError extends Error {
  readonly reasonCode = CANARY_WITNESS_PERSIST_ERROR_CODE;
  constructor(cause?: unknown) {
    super(`${CANARY_WITNESS_PERSIST_ERROR_CODE}${cause instanceof Error ? `: ${cause.message}` : ""}`);
    this.name = "CanaryWitnessPersistError";
  }
}

/** Payload del witness [PathDecision]. Sin secretos: source/enums + identidad Railway (system vars). */
export function buildPathDecisionWitness(a: {
  jobId: string;
  jobSource: string | null;
  inputs: PathDecisionInput;
  decision: PathDecision;
  pid: number;
  identity: WorkerIdentity;
}): Record<string, unknown> {
  return {
    schemaVersion: PATH_DECISION_SCHEMA_VERSION,
    jobId: a.jobId,
    jobSource: a.jobSource,
    partialFlagEnabled: a.inputs.partialFlagEnabled,
    catalogWriteMode: a.inputs.catalogWriteMode ?? null,
    extractionMode: a.inputs.extractionMode ?? null,
    selectedPath: a.decision.selectedPath,
    failedConjuncts: a.decision.failedConjuncts,
    pid: a.pid,
    railwayServiceName: a.identity.railwayServiceName,
    railwayServiceId: a.identity.railwayServiceId,
    railwayReplicaId: a.identity.railwayReplicaId,
    railwayDeploymentId: a.identity.railwayDeploymentId,
    railwayGitCommitSha: a.identity.railwayGitCommitSha,
  };
}

export interface SelectAndGuardDeps {
  inputs: PathDecisionInput;
  /** Emite el witness [PathDecision] de forma DURABLE (ExtractionLog awaited + consola). */
  emitWitness: (witnessLine: string) => Promise<void>;
  buildWitnessLine: (decision: PathDecision) => string;
}

/**
 * Evalúa el path UNA vez, emite el witness durable ANTES del scraper y aplica el guard del canary.
 * - Persistencia del witness falla + canary → CanaryWitnessPersistError (fail-closed, distinguible).
 * - Persistencia del witness falla + normal → se propaga tal cual (semántica de logging sin cambios).
 * - selectedPath === CANARY_FAIL_CLOSED → CanaryPreconditionError (nunca alcanza el scraper).
 * Devuelve la decisión (PARTIAL | HISTORICAL) para que el caller despache; el caller NO re-evalúa.
 */
export async function selectAndGuardPath(deps: SelectAndGuardDeps): Promise<PathDecision> {
  const decision = decideExecutionPath(deps.inputs);
  try {
    await deps.emitWitness(deps.buildWitnessLine(decision));
  } catch (e) {
    if (deps.inputs.isCanary) throw new CanaryWitnessPersistError(e);
    throw e;
  }
  if (decision.selectedPath === "CANARY_FAIL_CLOSED") {
    throw new CanaryPreconditionError(decision.failedConjuncts);
  }
  return decision;
}
