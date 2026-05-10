/**
 * BullMqQueue — Implementación futura con Redis + BullMQ.
 *
 * PENDIENTE DE IMPLEMENTAR. Este archivo es un stub que documenta
 * cómo migrar desde DbPollingQueue cuando se necesite escalar.
 *
 * Pasos para activar:
 *
 * 1. Instalar dependencias:
 *      npm install bullmq ioredis
 *
 * 2. Agregar a .env:
 *      REDIS_URL=redis://localhost:6379
 *
 * 3. Descomentar e implementar la clase abajo.
 *
 * 4. En worker/src/index.ts reemplazar:
 *      import { DbPollingQueue } from "./queues/db-polling-queue"
 *      const queue: IJobQueue = new DbPollingQueue(prisma)
 *    por:
 *      import { BullMqQueue } from "./queues/bullmq-queue"
 *      const queue: IJobQueue = new BullMqQueue()
 *
 *    El resto del worker no cambia porque depende de IJobQueue, no de la implementación.
 *
 * Ventajas de BullMQ sobre el polling actual:
 *   - Sin polling: reacción inmediata vía pub/sub de Redis
 *   - Reintentos automáticos configurables
 *   - Prioridades de jobs
 *   - Panel de monitoreo (Bull Board)
 *   - Rate limiting nativo
 *   - Jobs programados (cron)
 */

// import { Queue, Worker, Job } from "bullmq";
// import IORedis from "ioredis";
// import type { IJobQueue, JobPayload, JobResult } from "./job-queue.interface";
//
// const connection = new IORedis(process.env.REDIS_URL ?? "redis://localhost:6379", {
//   maxRetriesPerRequest: null,
// });
//
// export const QUEUE_NAME = "extractions";
//
// export class BullMqQueue implements IJobQueue {
//   private queue = new Queue(QUEUE_NAME, { connection });
//
//   async claimNextJob(): Promise<JobPayload | null> {
//     // BullMQ maneja el claim internamente en el Worker.
//     // Este método no se usa en la implementación BullMQ.
//     return null;
//   }
//
//   async markRunning(jobId: string): Promise<void> { /* handled by BullMQ */ }
//
//   async updateProgress(jobId: string, progress: number, totalProducts: number): Promise<void> {
//     // En BullMQ se usa job.updateProgress(progress) dentro del processor
//   }
//
//   async markCompleted(jobId: string, result: JobResult): Promise<void> { /* auto */ }
//   async markFailed(jobId: string, errorMessage: string): Promise<void> { /* auto */ }
//   async releaseStaleJobs(): Promise<number> { return 0; /* BullMQ lo maneja */ }
// }

export {}; // evita error de módulo vacío
