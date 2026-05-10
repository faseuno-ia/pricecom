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
}

export interface IJobQueue {
  /**
   * Intenta tomar el próximo job disponible de forma atómica.
   * Garantiza que dos workers concurrentes no puedan tomar el mismo job.
   * Retorna null si no hay jobs disponibles.
   */
  claimNextJob(): Promise<JobPayload | null>;

  /**
   * Marca el job como iniciado con timestamp y PID del worker.
   */
  markRunning(jobId: string): Promise<void>;

  /**
   * Actualiza el progreso (0-100) y cantidad de productos parciales.
   */
  updateProgress(jobId: string, progress: number, totalProducts: number): Promise<void>;

  /**
   * Marca el job como completado con estadísticas finales.
   */
  markCompleted(jobId: string, result: JobResult): Promise<void>;

  /**
   * Marca el job como fallido con mensaje de error.
   */
  markFailed(jobId: string, errorMessage: string): Promise<void>;

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
  excelFilePath: string | null;
  excelFileUrl: string | null;
}
