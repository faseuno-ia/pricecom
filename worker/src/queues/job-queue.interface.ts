/**
 * Interfaz de cola de jobs.
 *
 * Implementaciones disponibles:
 *   - DbPollingQueue   → polling en PostgreSQL (actual, sin dependencias extra)
 *   - BullMqQueue      → Redis + BullMQ (futura migración, solo requiere cambiar
 *                        la implementación concreta en worker/src/index.ts)
 *
 * Para migrar a BullMQ:
 *   1. Instalar: npm install bullmq ioredis
 *   2. Crear worker/src/queues/bullmq-queue.ts implementando esta interfaz
 *   3. En worker/src/index.ts cambiar:
 *        import { DbPollingQueue } from "./queues/db-polling-queue"
 *      por:
 *        import { BullMqQueue } from "./queues/bullmq-queue"
 *   4. El resto del código no cambia.
 */
export interface JobPayload {
  jobId: string;
  providerId: string;
  /** 2G-R8-Q1 · versión de lease (workerLockedAt del claim). Fencing token para heartbeat/terminal. */
  leaseVersion: Date;
}

/** Resultado de una renovación de lease (heartbeat CAS). */
export type LeaseRenewResult =
  | { kind: "OWNED"; leaseVersion: Date } // CAS afectó 1 fila → seguimos siendo dueños; nueva versión
  | { kind: "LOST" } // CAS afectó 0 filas → ownership perdido (reclaim/nuevo claim)
  | { kind: "UNKNOWN" }; // el CAS lanzó (DB error/timeout) → ownership indeterminado (fail-closed)

/** NEON-GATE2A-EXEC-2-F1 · Foto de la fila, suficiente para elegir rama sin poder mutar nada. */
export interface JobInspection {
  status: string;
  /** ¿`workerLockedAt` dentro del umbral? false también si no hay lease o el job no está RUNNING. */
  leaseAlive: boolean;
}

export interface IJobQueue {
  /**
   * Intenta tomar el próximo job disponible de forma atómica.
   * Garantiza que dos workers concurrentes no puedan tomar el mismo job.
   * Retorna null si no hay jobs disponibles.
   */
  claimNextJob(): Promise<JobPayload | null>;

  /**
   * NEON-GATE2A-EXEC-2 · Claim DIRIGIDO: reclama ESE job y ningún otro. Misma atomicidad
   * (UPDATE … FOR UPDATE SKIP LOCKED … RETURNING) y mismo filtro de source. Devuelve null si el
   * job ya no es reclamable (no PENDING, tomado por otra tx, o source=IMPORT).
   */
  claimJob(jobId: string): Promise<JobPayload | null>;

  /**
   * NEON-GATE2A-EXEC-2 · Claim del fallback legacy, restringido a jobs creados dentro de la
   * ventana de atención. Nunca toma trabajo abandonado ⇒ no reintroduce drain global.
   */
  claimNextAttendedJob(attendedWindowMs: number): Promise<JobPayload | null>;

  /**
   * NEON-GATE2A-EXEC-2 · Testigo de detección: ¿el job sigue RUNNING con lease renovado dentro
   * del umbral? Sólo lectura; jamás muta ni resetea estado.
   */
  isRunningLeaseAlive(jobId: string, thresholdMs: number): Promise<boolean>;

  /**
   * NEON-GATE2A-EXEC-2-F1 · Lectura pura de la fila para DECIDIR el camino del wake cuando el
   * claim dirigido devuelve null. Es ORIENTATIVA, no autoridad: entre esta lectura y el release
   * la fila puede moverse, y por eso el release re-verifica su propio predicado.
   */
  inspectJob(jobId: string, liveLeaseThresholdMs: number): Promise<JobInspection | null>;

  /**
   * NEON-GATE2A-EXEC-2 · Stale recovery PEREZOSA acotada a un jobId, con el predicado
   * re-verificado en la misma sentencia y PRESERVANDO startedAt/errorMessage.
   */
  releaseStaleJob(jobId: string, staleAfterMs: number): Promise<boolean>;

  /**
   * Marca el job como iniciado con timestamp y PID del worker.
   */
  markRunning(jobId: string): Promise<void>;

  /**
   * Actualiza el progreso (0-100) y cantidad de productos parciales.
   */
  updateProgress(jobId: string, progress: number, totalProducts: number): Promise<void>;

  /**
   * 2G-R8-Q1 · Heartbeat CAS del lease. Renueva workerLockedAt SOLO si seguimos siendo dueños
   * (status=RUNNING AND workerLockedAt=expected). Devuelve OWNED (con nueva versión), LOST (0 filas)
   * o UNKNOWN (el CAS lanzó). NUNCA usar un WHERE sólo por id/status (robaría el lease del nuevo dueño).
   */
  renewLease(jobId: string, expectedLeaseVersion: Date): Promise<LeaseRenewResult>;

  /**
   * Marca COMPLETED sólo si seguimos siendo dueños (CAS sobre expectedLeaseVersion). Devuelve true
   * si terminalizamos (afectó 1 fila), false si el ownership ya no era nuestro (0 filas, suprimido).
   */
  markCompleted(jobId: string, result: JobResult, expectedLeaseVersion: Date): Promise<boolean>;

  /**
   * Marca FAILED sólo si seguimos siendo dueños (CAS). Devuelve true/false como markCompleted.
   */
  markFailed(jobId: string, errorMessage: string, expectedLeaseVersion: Date): Promise<boolean>;

  /**
   * Libera jobs bloqueados por workers que murieron sin completar.
   * Llamar periódicamente en el poll loop.
   * @param staleAfterMs  Tiempo en ms tras el cual un job RUNNING sin actualización se libera (default: 10 min)
   */
  releaseStaleJobs(staleAfterMs?: number): Promise<number>;
}

export interface JobResult {
  totalProducts: number;
  productsWithPrice: number;
  productsWithoutPrice: number;
  productsWithoutSku: number;
  /// Path en disco — legacy, los jobs nuevos lo dejan null porque el Excel
  /// vive en la columna excelData de la DB.
  excelFilePath: string | null;
  excelFileUrl: string | null;
  /// Binario del Excel para persistir en ExtractionJob.excelData.
  excelData: Buffer | null;
  /// Nombre del archivo (clave por la que busca el endpoint de descarga).
  excelName: string | null;
}
