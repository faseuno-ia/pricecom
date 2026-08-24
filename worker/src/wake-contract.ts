// NEON-GATE2A-EXEC-2 · Contrato de respuesta del endpoint /wake (lado worker).
//
// Estos literales tienen que coincidir EXACTAMENTE con los que clasifica el emisor
// (lib/worker/wake-client.ts, WORKER_2XX_OUTCOMES). Si divergen, el web manda todo a
// UNRECOGNIZED_RESPONSE y nadie se entera: el wake "funciona" pero el operador ve basura.
//
// La coincidencia está afirmada por tests/unit/worker-event-driven-structural.test.ts, que compara
// los dos conjuntos en runtime.

/** Header por el que viaja el secreto compartido. */
export const WAKE_SECRET_HEADER = "x-worker-wake-secret";

export type WakeResponseOutcome =
  | "ACCEPTED_AND_CLAIMED"
  | "WORKER_BUSY_NOT_CLAIMED"
  | "JOB_NOT_RECLAIMABLE"
  | "LEGACY_MODE_ACTIVE"
  | "STUCK_CLAIMING_SUSPECTED"
  | "STUCK_BUSY_SUSPECTED";

/** Los outcomes que el worker puede devolver con 2xx. */
export const WAKE_RESPONSE_OUTCOMES: readonly WakeResponseOutcome[] = [
  "ACCEPTED_AND_CLAIMED",
  "WORKER_BUSY_NOT_CLAIMED",
  "JOB_NOT_RECLAIMABLE",
  "LEGACY_MODE_ACTIVE",
  "STUCK_CLAIMING_SUSPECTED",
  "STUCK_BUSY_SUSPECTED",
];

/**
 * Respuestas de error. El emisor las clasifica como WORKER_ERROR_RESPONSE por el status no-2xx,
 * así que el `outcome` de estas es informativo para logs, no parte del contrato de clasificación.
 */
export type WakeErrorOutcome = "UNAUTHORIZED" | "INVALID_JOB" | "INTERNAL_ERROR";
