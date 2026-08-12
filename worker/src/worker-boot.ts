// 2G-R9-PR1 · Arranque determinístico del worker. FAIL-CLOSED por WORKER_ENABLED.
//
// Semántica (estricta, sin fail-open):
//   WORKER_ENABLED === "true"  → arranca el poll loop.
//   ausente | "false" | "0" | "1" | "yes" | cualquier otro valor → NO arranca; queda idle emitiendo
//     un heartbeat de modo-deshabilitado cada 60 s, SIN leer la cola ni escribir la DB.
//
// Dos eventos DISTINTOS (no se mezclan):
//   [WorkerBoot]              — UNA vez por proceso, en AMBOS modos. Evento de IDENTIDAD: su conteo
//                               (WORKER_BOOT_COUNT_ACROSS_ALL_SERVICES) es el testigo de ejecutor.
//   [WorkerDisabledHeartbeat] — cada 60 s, SÓLO en modo deshabilitado. Evento de ESTADO: su repetición
//                               es la señal. Distingue "no arrancó" de "arrancó y no consume".
//
// Sin secretos: los campos de identidad son variables de sistema inyectadas por Railway.

export const WORKER_BOOT_SCHEMA_VERSION = 1 as const;
export const DISABLED_HEARTBEAT_INTERVAL_MS = 60_000;

/** FAIL-CLOSED: verdadero SÓLO ante el literal "true". Nada más habilita el poller. */
export function resolveWorkerEnabled(raw: string | undefined): boolean {
  return raw === "true";
}

export interface WorkerIdentity {
  railwayServiceName: string | null;
  railwayServiceId: string | null;
  railwayReplicaId: string | null;
  railwayDeploymentId: string | null;
  railwayGitCommitSha: string | null;
}

export function readWorkerIdentity(env: Record<string, string | undefined>): WorkerIdentity {
  return {
    railwayServiceName: env.RAILWAY_SERVICE_NAME ?? null,
    railwayServiceId: env.RAILWAY_SERVICE_ID ?? null,
    railwayReplicaId: env.RAILWAY_REPLICA_ID ?? null,
    railwayDeploymentId: env.RAILWAY_DEPLOYMENT_ID ?? null,
    railwayGitCommitSha: env.RAILWAY_GIT_COMMIT_SHA ?? null,
  };
}

export function buildWorkerBootWitness(a: {
  workerEnabled: boolean; pollerStarted: boolean; pid: number; identity: WorkerIdentity;
}): Record<string, unknown> {
  return {
    schemaVersion: WORKER_BOOT_SCHEMA_VERSION,
    workerEnabled: a.workerEnabled,
    pollerStarted: a.pollerStarted,
    pid: a.pid,
    railwayServiceName: a.identity.railwayServiceName,
    railwayServiceId: a.identity.railwayServiceId,
    railwayReplicaId: a.identity.railwayReplicaId,
    railwayDeploymentId: a.identity.railwayDeploymentId,
    railwayGitCommitSha: a.identity.railwayGitCommitSha,
  };
}

export function buildDisabledHeartbeatWitness(a: { pid: number; identity: WorkerIdentity }): Record<string, unknown> {
  return {
    schemaVersion: WORKER_BOOT_SCHEMA_VERSION,
    workerEnabled: false,
    pollerStarted: false,
    pid: a.pid,
    railwayServiceName: a.identity.railwayServiceName,
    railwayReplicaId: a.identity.railwayReplicaId,
    railwayDeploymentId: a.identity.railwayDeploymentId,
    railwayGitCommitSha: a.identity.railwayGitCommitSha,
  };
}

export interface BootDeps {
  workerEnabledRaw: string | undefined;
  pid: number;
  env: Record<string, string | undefined>;
  /** Sink de los witnesses. Sólo consola: al arranque NO hay jobId → ExtractionLog no corresponde. */
  emit: (message: string) => void;
  /** El poll loop real (única superficie que lee la cola). */
  startPoller: () => void;
  /** Programa el heartbeat de modo-deshabilitado. En modo habilitado NO se invoca (timer no arranca). */
  scheduleDisabledHeartbeat: (onTick: () => void, intervalMs: number) => void;
}

export interface BootResult {
  workerEnabled: boolean;
  pollerStarted: boolean;
  disabledHeartbeatScheduled: boolean;
}

/**
 * Decide el arranque de forma determinística. Emite [WorkerBoot] EXACTAMENTE UNA VEZ (ambos modos)
 * antes de cualquier otra cosa; luego arranca el poller (habilitado) o programa el heartbeat de estado
 * (deshabilitado). Testeable por inyección de deps: no toca timers/cola/DB reales.
 */
export function bootWorker(deps: BootDeps): BootResult {
  const workerEnabled = resolveWorkerEnabled(deps.workerEnabledRaw);
  const identity = readWorkerIdentity(deps.env);

  deps.emit(`[WorkerBoot] ${JSON.stringify(buildWorkerBootWitness({ workerEnabled, pollerStarted: workerEnabled, pid: deps.pid, identity }))}`);

  if (workerEnabled) {
    deps.startPoller();
    return { workerEnabled: true, pollerStarted: true, disabledHeartbeatScheduled: false };
  }

  deps.scheduleDisabledHeartbeat(() => {
    deps.emit(`[WorkerDisabledHeartbeat] ${JSON.stringify(buildDisabledHeartbeatWitness({ pid: deps.pid, identity }))}`);
  }, DISABLED_HEARTBEAT_INTERVAL_MS);
  return { workerEnabled: false, pollerStarted: false, disabledHeartbeatScheduled: true };
}
