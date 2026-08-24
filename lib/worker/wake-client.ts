// NEON-GATE2A-EXEC-1 · Emisión del wake al worker.
//
// El web crea el ExtractionJob y avisa al worker que hay trabajo. La señal SÓLO despierta: la
// autoridad de ejecución vive en la fila de ExtractionJob, y el claim dirigido del worker
// (2A-EXEC-2) es quien decide. Por eso el body es EXACTAMENTE { jobId } — nada de providerId,
// URL de scraping, write mode ni payload comercial.
//
// INVARIANTE BLOQUEANTE
//   WAKE_FAILURE_BREAKS_CREATE = false
//   emitWake es TOTAL: nunca lanza. Un wake fallido no puede hacer fallar la creación del job.
//   Todo fallo se devuelve como valor, clasificado.
//
// CONFIGURACIÓN AUSENTE = NO INTENTAR
//   Sin WORKER_WAKE_URL o WORKER_WAKE_SECRET no se hace NINGUNA llamada HTTP. Es el estado
//   esperado en la ventana entre 2A-EXEC-1 y 2A-EXEC-2: el código llega inerte a producción y
//   se enciende cargando las variables, sin otro deploy.
//
// Reusable por el redispatch de 2B: recibe jobId y nada más.

import { logInfo, logWarning, logError } from "@/lib/events/event-log";

export const WAKE_HTTP_TIMEOUT_MS = 5000;

/** Header por el que viaja el secreto compartido. El worker lo compara en tiempo constante. */
export const WAKE_SECRET_HEADER = "x-worker-wake-secret";

/**
 * Resultado clasificado de un intento de wake.
 *
 * Del worker, 2xx (contrato congelado en NEON-GATE2A):
 *   ACCEPTED_AND_CLAIMED       reclamó el job y lo va a ejecutar
 *   WORKER_BUSY_NOT_CLAIMED    hay una ejecución en vuelo · + phase CLAIMING | RUNNING
 *   JOB_NOT_RECLAIMABLE        el claim devolvió 0 filas (no PENDING / ya tomado / IMPORT)
 *   LEGACY_MODE_ACTIVE         el fallback de poll está encendido; este endpoint no reclama
 *   STUCK_CLAIMING_SUSPECTED   CLAIMING excedió su cota
 *   STUCK_BUSY_SUSPECTED       RUNNING local sin ejecución real
 *
 * Del worker, no-2xx:
 *   WORKER_ERROR_RESPONSE      incluye UNAUTHORIZED / INVALID_JOB / INTERNAL_ERROR
 *
 * Del transporte / configuración:
 *   TRANSPORT_ERROR            + reason TIMEOUT | ECONNREFUSED | ENOTFOUND | OTHER
 *   WORKER_WAKE_NOT_CONFIGURED sin variables ⇒ CERO llamadas
 *   UNRECOGNIZED_RESPONSE      2xx con cuerpo desconocido o no parseable
 *
 * El web NUNCA asume que un error del wake significa extracción fallida: el job ya existe y es
 * redispatchable.
 */
export type WakeOutcome =
  | "ACCEPTED_AND_CLAIMED"
  | "WORKER_BUSY_NOT_CLAIMED"
  | "JOB_NOT_RECLAIMABLE"
  | "LEGACY_MODE_ACTIVE"
  | "STUCK_CLAIMING_SUSPECTED"
  | "STUCK_BUSY_SUSPECTED"
  | "WORKER_ERROR_RESPONSE"
  | "TRANSPORT_ERROR"
  | "WORKER_WAKE_NOT_CONFIGURED"
  | "UNRECOGNIZED_RESPONSE";

export type WakeTransportReason = "TIMEOUT" | "ECONNREFUSED" | "ENOTFOUND" | "OTHER";

export type WakePhase = "CLAIMING" | "RUNNING";

export interface WakeResult {
  outcome: WakeOutcome;
  /** Sólo en TRANSPORT_ERROR: por qué falló el transporte. */
  reason?: WakeTransportReason;
  /** Sólo en WORKER_BUSY_NOT_CLAIMED: en qué fase está el worker. */
  phase?: WakePhase;
  /** jobId que ocupa al worker, si lo informa. */
  occupantJobId?: string;
  /** Status HTTP, cuando hubo respuesta. */
  httpStatus?: number;
  /** Milisegundos del intento. Ausente si no se intentó. */
  elapsedMs?: number;
  /** Valor crudo de `outcome` cuando no se reconoce, para diagnóstico. */
  rawOutcome?: string;
}

/**
 * Outcomes que el worker puede devolver con 2xx.
 * Exportado para que el test estructural compare este conjunto contra el del worker: si divergen,
 * el emisor manda todo a UNRECOGNIZED_RESPONSE y nadie se entera.
 */
export const WORKER_2XX_OUTCOMES = new Set<WakeOutcome>([
  "ACCEPTED_AND_CLAIMED",
  "WORKER_BUSY_NOT_CLAIMED",
  "JOB_NOT_RECLAIMABLE",
  "LEGACY_MODE_ACTIVE",
  "STUCK_CLAIMING_SUSPECTED",
  "STUCK_BUSY_SUSPECTED",
]);

/** El worker contestó y decidió NO reclamar: no es un fallo del sistema. */
const ANSWERED_BUT_NOT_CLAIMED = new Set<WakeOutcome>([
  "WORKER_BUSY_NOT_CLAIMED",
  "JOB_NOT_RECLAIMABLE",
  "LEGACY_MODE_ACTIVE",
  "STUCK_CLAIMING_SUSPECTED",
  "STUCK_BUSY_SUSPECTED",
]);

function readConfig(): { url: string; secret: string } | null {
  const url = process.env.WORKER_WAKE_URL?.trim();
  const secret = process.env.WORKER_WAKE_SECRET?.trim();
  if (!url || !secret) return null;
  return { url, secret };
}

/**
 * ENOTFOUND y ECONNREFUSED NO son lo mismo y no deben colapsarse en "falló":
 *   ENOTFOUND      el hostname privado no resuelve → está mal escrito, o falta el servicio
 *   ECONNREFUSED   el hostname resuelve pero nadie escucha → es EXACTAMENTE lo esperado contra
 *                  el worker de 2A-EXEC-1, que todavía no tiene endpoint
 * Cuando Daniel cargue las variables, esa diferencia es la que dice si el problema es de DNS o
 * de deploy.
 */
function classifyTransportError(err: unknown): WakeTransportReason {
  const name = (err as { name?: unknown })?.name;
  if (name === "TimeoutError" || name === "AbortError") return "TIMEOUT";

  const cause = (err as { cause?: unknown })?.cause;
  const code = (cause as { code?: unknown })?.code ?? (err as { code?: unknown })?.code;
  if (code === "ECONNREFUSED") return "ECONNREFUSED";
  if (code === "ENOTFOUND") return "ENOTFOUND";

  return "OTHER";
}

/**
 * SEVERIDAD SEGÚN CONFIGURACIÓN — no según fecha ni flag manual.
 *
 * Sin configurar, un wake que no ocurre es el estado ESPERADO de la migración ⇒ INFO.
 * Configurado, alguien afirmó explícitamente que el worker debe responder; que no responda es
 * un incidente ⇒ ERROR. La distinción se auto-resuelve el día que se cargan las variables, sin
 * que nadie tenga que acordarse de cambiar nada.
 */
async function record(jobId: string, result: WakeResult): Promise<void> {
  const metadata = {
    jobId,
    outcome: result.outcome,
    reason: result.reason,
    phase: result.phase,
    occupantJobId: result.occupantJobId,
    httpStatus: result.httpStatus,
    elapsedMs: result.elapsedMs,
    rawOutcome: result.rawOutcome,
  };

  if (result.outcome === "WORKER_WAKE_NOT_CONFIGURED") {
    await logInfo({
      source: "EXTRACTION",
      type: "WAKE_NOT_CONFIGURED",
      title: "Wake no configurado — no se intentó despertar al worker",
      description:
        "WORKER_WAKE_URL / WORKER_WAKE_SECRET ausentes. El job quedó PENDING y es redispatchable.",
      jobId,
      metadata,
    });
    return;
  }

  if (result.outcome === "ACCEPTED_AND_CLAIMED") {
    await logInfo({
      source: "EXTRACTION",
      type: "WAKE_ACCEPTED",
      title: "Worker despertado y job reclamado",
      jobId,
      metadata,
    });
    return;
  }

  if (ANSWERED_BUT_NOT_CLAIMED.has(result.outcome)) {
    await logWarning({
      source: "EXTRACTION",
      type: "WAKE_NOT_CLAIMED",
      title: `El worker respondió sin reclamar el job (${result.outcome})`,
      jobId,
      metadata,
    });
    return;
  }

  await logError({
    source: "EXTRACTION",
    type: "WAKE_FAILED",
    title: `Falló el wake al worker (${result.outcome}${result.reason ? ` · ${result.reason}` : ""})`,
    description:
      "El job se creó igual y quedó PENDING: es redispatchable. La extracción no arrancó automáticamente.",
    jobId,
    metadata,
  });
}

async function classifyResponse(res: Response): Promise<WakeResult> {
  if (!res.ok) {
    return { outcome: "WORKER_ERROR_RESPONSE", httpStatus: res.status };
  }

  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return { outcome: "UNRECOGNIZED_RESPONSE", httpStatus: res.status };
  }

  const body = (parsed ?? {}) as {
    outcome?: unknown;
    phase?: unknown;
    occupantJobId?: unknown;
  };
  const raw = typeof body.outcome === "string" ? body.outcome : undefined;

  if (!raw || !WORKER_2XX_OUTCOMES.has(raw as WakeOutcome)) {
    return { outcome: "UNRECOGNIZED_RESPONSE", httpStatus: res.status, rawOutcome: raw };
  }

  const result: WakeResult = { outcome: raw as WakeOutcome, httpStatus: res.status };
  if (body.phase === "CLAIMING" || body.phase === "RUNNING") result.phase = body.phase;
  if (typeof body.occupantJobId === "string") result.occupantJobId = body.occupantJobId;
  return result;
}

/**
 * Despierta al worker para un job concreto. NUNCA lanza.
 *
 * @param jobId único dato que viaja. La DB provee el resto.
 */
export async function emitWake(jobId: string): Promise<WakeResult> {
  let result: WakeResult;

  try {
    const config = readConfig();
    if (!config) {
      // CERO llamadas HTTP: no es "una llamada que falla", es "no se intenta".
      result = { outcome: "WORKER_WAKE_NOT_CONFIGURED" };
    } else {
      const startedAt = Date.now();
      try {
        const res = await fetch(config.url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            [WAKE_SECRET_HEADER]: config.secret,
          },
          body: JSON.stringify({ jobId }),
          signal: AbortSignal.timeout(WAKE_HTTP_TIMEOUT_MS),
        });
        result = { ...(await classifyResponse(res)), elapsedMs: Date.now() - startedAt };
      } catch (err) {
        result = {
          outcome: "TRANSPORT_ERROR",
          reason: classifyTransportError(err),
          elapsedMs: Date.now() - startedAt,
        };
      }
    }
  } catch {
    // Red de contención final: emitWake es TOTAL por contrato. Si algo inesperado rompiera
    // incluso la lectura de configuración, se devuelve un valor y no se propaga.
    result = { outcome: "TRANSPORT_ERROR", reason: "OTHER" };
  }

  try {
    await record(jobId, result);
  } catch {
    // logEvent ya no lanza (event-log.ts:55-60); esto es defensa en profundidad para que el
    // audit trail jamás pueda romper la creación del job.
  }

  return result;
}
