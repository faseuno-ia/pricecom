// NEON-GATE2A-EXEC-2 · Servidor HTTP del worker · endpoint /wake.
//
// La señal SÓLO despierta. La autoridad de ejecución vive en la fila de ExtractionJob y la ejerce
// el claim dirigido; el jobId del wake es SELECTOR DEL CANDIDATO, no permiso de ejecución.
//
// El handler está separado del transporte (`handleWake` no toca sockets) para poder probar la
// exclusión y las transiciones sin abrir puertos.

import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { JobInspection, JobPayload } from "./queues/job-queue.interface";
import { ExecutionState } from "./execution-state";
import {
  WAKE_SECRET_HEADER,
  type WakeErrorOutcome,
  type WakeResponseOutcome,
} from "./wake-contract";

export interface WakeWitness {
  type: "STUCK_CLAIMING_SUSPECTED" | "STUCK_BUSY_SUSPECTED" | "ORPHAN_RUNNING_RELEASED";
  jobId: string;
  metadata?: Record<string, unknown>;
}

export interface WakeDeps {
  /** Secreto compartido. Si falta, NINGÚN wake se acepta (fail-closed). */
  secret: string | undefined;
  state: ExecutionState;
  /** Con el fallback encendido este endpoint NO reclama: un solo dueño del claim. */
  legacyFallbackEnabled: boolean;
  claimMaxDurationMs: number;
  liveLeaseThresholdMs: number;
  now(): number;
  claimJob(jobId: string): Promise<JobPayload | null>;
  isRunningLeaseAlive(jobId: string, thresholdMs: number): Promise<boolean>;
  /** F1 · lectura pura para elegir rama cuando el claim dirigido devuelve null. */
  inspectJob(jobId: string, liveLeaseThresholdMs: number): Promise<JobInspection | null>;
  /** F1 · release acotado por jobId. Re-verifica staleness DENTRO de su sentencia. */
  releaseStaleJob(jobId: string, staleAfterMs: number): Promise<boolean>;
  /** Arranca processJob DESACOPLADO de la request. Nunca lanza hacia el handler. */
  startExecution(payload: JobPayload): void;
  onWitness(w: WakeWitness): Promise<void>;
}

export interface WakeHttpResult {
  status: number;
  body: {
    outcome: WakeResponseOutcome | WakeErrorOutcome;
    phase?: "CLAIMING" | "RUNNING";
    occupantJobId?: string;
  };
  /**
   * Tarea a ejecutar DESPUÉS de escribir la respuesta. El claim ocurre dentro de la request (para
   * que la respuesta reporte un hecho consumado), pero la extracción —de minutos— no puede quedar
   * atada al lifetime del socket.
   */
  afterRespond?: () => void;
}

export interface WakeRequest {
  secretHeader?: string;
  rawBody: string;
}

/** Comparación en tiempo constante, resistente a diferencias de longitud. */
function secretMatches(expected: string | undefined, received: string | undefined): boolean {
  if (!expected || !received) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(received);
  if (a.length !== b.length) {
    // Igual gastamos una comparación para no filtrar la longitud por tiempo.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

function parseJobId(rawBody: string): string | null {
  try {
    const parsed = JSON.parse(rawBody) as { jobId?: unknown };
    const jobId = parsed?.jobId;
    return typeof jobId === "string" && jobId.trim().length > 0 ? jobId.trim() : null;
  } catch {
    return null;
  }
}

export async function handleWake(
  deps: WakeDeps,
  req: WakeRequest,
): Promise<WakeHttpResult> {
  // ── 1 · auth (síncrono) ──────────────────────────────────────────────────
  if (!secretMatches(deps.secret, req.secretHeader)) {
    return { status: 401, body: { outcome: "UNAUTHORIZED" } };
  }

  // ── 2 · body (síncrono). SÓLO jobId; nada más es autoridad. ──────────────
  const jobId = parseJobId(req.rawBody);
  if (!jobId) return { status: 400, body: { outcome: "INVALID_JOB" } };

  // ── 3 · fallback (síncrono): exclusión mutua con el poll ─────────────────
  if (deps.legacyFallbackEnabled) {
    return { status: 200, body: { outcome: "LEGACY_MODE_ACTIVE" } };
  }

  // ── 4 · EXCLUSIÓN · check-and-set SÍNCRONO ───────────────────────────────
  // Hasta acá no hubo NI UN await desde que entró la request. Ésa es la propiedad: el event loop
  // serializa dos wakes concurrentes y el segundo ve el estado ya tomado.
  const now = deps.now();
  const begin = deps.state.tryBeginClaiming(jobId, now);

  if (!begin.ok) {
    const current = begin.current;

    if (current.phase === "CLAIMING") {
      const age = now - current.since;
      if (age > deps.claimMaxDurationMs) {
        // La cota se evalúa acá, al llegar OTRO wake. No hay timer.
        await deps.onWitness({
          type: "STUCK_CLAIMING_SUSPECTED",
          jobId: current.jobId,
          metadata: { ageMs: age, claimMaxDurationMs: deps.claimMaxDurationMs, requestedJobId: jobId },
        });
        return {
          status: 200,
          body: { outcome: "STUCK_CLAIMING_SUSPECTED", phase: "CLAIMING", occupantJobId: current.jobId },
        };
      }
      return {
        status: 200,
        body: { outcome: "WORKER_BUSY_NOT_CLAIMED", phase: "CLAIMING", occupantJobId: current.jobId },
      };
    }

    if (current.phase === "RUNNING") {
      // La DB como TESTIGO: si dice que no hay lease vivo, lo reportamos… y no tocamos nada.
      let leaseAlive = true;
      try {
        leaseAlive = await deps.isRunningLeaseAlive(current.jobId, deps.liveLeaseThresholdMs);
      } catch {
        leaseAlive = true; // ante duda, se asume ocupado: nunca liberar por sospecha
      }
      if (!leaseAlive) {
        await deps.onWitness({
          type: "STUCK_BUSY_SUSPECTED",
          jobId: current.jobId,
          metadata: { requestedJobId: jobId, liveLeaseThresholdMs: deps.liveLeaseThresholdMs },
        });
        return {
          status: 200,
          body: { outcome: "STUCK_BUSY_SUSPECTED", phase: "RUNNING", occupantJobId: current.jobId },
        };
      }
      return {
        status: 200,
        body: { outcome: "WORKER_BUSY_NOT_CLAIMED", phase: "RUNNING", occupantJobId: current.jobId },
      };
    }

    // Inalcanzable (IDLE siempre gana el CAS), pero no se asume.
    return { status: 200, body: { outcome: "WORKER_BUSY_NOT_CLAIMED" } };
  }

  // ── 5 · claim dirigido, y recuperación del huérfano si pierde ────────────
  //
  // ONE_WAKE = ONE_ATTEMPT. Un wake gasta como máximo UN release y DOS claims (el directo y el de
  // reintento). No hay bucle release → claim → release → claim: un wake que no logra ejecutar
  // devuelve JOB_NOT_RECLAIMABLE y la decisión de volver a intentar es de quien despierta.
  try {
    let payload: JobPayload | null;
    try {
      payload = await deps.claimJob(jobId);
    } catch {
      return { status: 500, body: { outcome: "INTERNAL_ERROR" } };
    }

    if (!payload) {
      // El claim perdió. Antes de F1 esto era el final del camino, y un job huérfano —fila RUNNING
      // con el lease de un worker muerto— respondía JOB_NOT_RECLAIMABLE para siempre: el estado
      // local es IDLE tras el reinicio, así que la rama de STUCK_BUSY_SUSPECTED ni se evalúa.
      let seen: JobInspection | null;
      try {
        seen = await deps.inspectJob(jobId, deps.liveLeaseThresholdMs);
      } catch {
        // Sin foto no se decide liberar nada: fail-closed.
        return { status: 200, body: { outcome: "JOB_NOT_RECLAIMABLE" } };
      }

      if (!seen || seen.status !== "RUNNING") {
        return { status: 200, body: { outcome: "JOB_NOT_RECLAIMABLE" } };
      }

      if (seen.leaseAlive) {
        // Alguien lo está ejecutando AHORA y renovando el lease. Liberarlo sería robárselo.
        return {
          status: 200,
          body: { outcome: "WORKER_BUSY_NOT_CLAIMED", phase: "RUNNING", occupantJobId: jobId },
        };
      }

      // RUNNING con lease vencido: el huérfano. UN release, acotado por jobId.
      let released = false;
      try {
        released = await deps.releaseStaleJob(jobId, deps.liveLeaseThresholdMs);
      } catch {
        released = false;
      }

      await deps.onWitness({
        type: "ORPHAN_RUNNING_RELEASED",
        jobId,
        metadata: { released, liveLeaseThresholdMs: deps.liveLeaseThresholdMs },
      });

      // El claim restante se consume EN AMBOS CASOS.
      //
      // `released === false` significa que otro actor movió la fila entre la inspección y el
      // release —la foto era orientativa, no autoridad— y NO que siga stale. Por eso no se
      // reintenta el release ni se reevalúa la staleness: sólo se gasta el claim que queda. Si ese
      // otro actor la dejó PENDING, el claim gana; si se la quedó, perdemos y respondemos honesto.
      try {
        payload = await deps.claimJob(jobId);
      } catch {
        return { status: 500, body: { outcome: "INTERNAL_ERROR" } };
      }
      if (!payload) {
        return { status: 200, body: { outcome: "JOB_NOT_RECLAIMABLE" } };
      }
    }

    // ── 6 · CLAIMING → RUNNING, y la ejecución se desacopla ────────────────
    if (!deps.state.promoteToRunning(jobId, deps.now())) {
      // Nadie más puede haber tocado el estado (single-flight), pero si pasara, no ejecutamos.
      return { status: 500, body: { outcome: "INTERNAL_ERROR" } };
    }

    const claimed = payload;
    return {
      status: 200,
      body: { outcome: "ACCEPTED_AND_CLAIMED" },
      afterRespond: () => deps.startExecution(claimed),
    };
  } finally {
    // RELEASE_ON_CLAIM_PATH · gane o pierda. Es CAS sobre (fase, jobId): si el claim prosperó y ya
    // promovimos a RUNNING, esto es un no-op y NO puede pisar la ejecución recién arrancada.
    deps.state.releaseClaiming(jobId);
  }
}

export interface WakeServerOptions {
  host: string;
  port: number;
  deps: WakeDeps;
  onLog?: (message: string) => void;
}

/**
 * Levanta el servidor HTTP. Bind a `::` obligatorio en Railway: la red privada es IPv6-only, y
 * bindear a 0.0.0.0 o localhost deja el servicio inalcanzable desde el web.
 */
export function startWakeServer(opts: WakeServerOptions): Server {
  const server = createServer((req, res) => {
    if (req.method !== "POST" || !(req.url ?? "").startsWith("/wake")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ outcome: "INVALID_JOB" }));
      return;
    }

    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("error", () => {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ outcome: "INVALID_JOB" }));
    });
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks).toString("utf8");
      const header = req.headers[WAKE_SECRET_HEADER];
      const secretHeader = Array.isArray(header) ? header[0] : header;

      void handleWake(opts.deps, { secretHeader, rawBody })
        .then((result) => {
          res.writeHead(result.status, { "content-type": "application/json" });
          res.end(JSON.stringify(result.body));
          // DESPUÉS de responder: la extracción no queda atada al socket.
          if (result.afterRespond) setImmediate(result.afterRespond);
        })
        .catch((err) => {
          opts.onLog?.(`[WakeServer] handler falló: ${err instanceof Error ? err.message : String(err)}`);
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ outcome: "INTERNAL_ERROR" }));
        });
    });
  });

  server.listen(opts.port, opts.host, () => {
    opts.onLog?.(`[WakeServer] escuchando en [${opts.host}]:${opts.port}/wake`);
  });

  return server;
}
