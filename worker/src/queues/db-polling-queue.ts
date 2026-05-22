import { PrismaClient } from "@prisma/client";
import type { IJobQueue, JobPayload, JobResult } from "./job-queue.interface";

/**
 * Implementación de IJobQueue usando polling en PostgreSQL.
 *
 * El bloqueo atómico se logra con una query SQL que hace UPDATE + RETURNING
 * en una sola operación, lo que garantiza que dos workers concurrentes
 * nunca puedan tomar el mismo job, incluso sin Redis.
 *
 * Query equivalente:
 *   UPDATE "ExtractionJob"
 *   SET    status = 'RUNNING', "workerLockedAt" = now(), "workerPid" = $pid
 *   WHERE  id = (
 *     SELECT id FROM "ExtractionJob"
 *     WHERE  status = 'PENDING'
 *     ORDER  BY "createdAt" ASC
 *     LIMIT  1
 *     FOR UPDATE SKIP LOCKED   ← clave: skipea filas bloqueadas por otro worker
 *   )
 *   RETURNING id, "providerId";
 */
export class DbPollingQueue implements IJobQueue {
  constructor(private readonly prisma: PrismaClient) {}

  async claimNextJob(): Promise<JobPayload | null> {
    // FOR UPDATE SKIP LOCKED es la primitiva de PostgreSQL para worker pools:
    // cada worker ve solo filas que ningún otro tiene bloqueadas en su transacción.
    // Filtramos por source: los jobs con source='IMPORT' son sintéticos
    // (creados por POST /api/catalog/import para emitir el diff de cambios
    // contra un Excel) y nunca deben procesarse acá. source IS NULL es el
    // default histórico = scraper automático.
    const rows = await this.prisma.$queryRaw<{ id: string; providerId: string }[]>`
      UPDATE "ExtractionJob"
      SET
        status         = 'RUNNING',
        "workerLockedAt" = NOW(),
        "workerPid"    = ${process.pid},
        "startedAt"    = NOW(),
        "updatedAt"    = NOW()
      WHERE id = (
        SELECT id
        FROM   "ExtractionJob"
        WHERE  status = 'PENDING'
        AND    ("source" IS NULL OR "source" <> 'IMPORT')
        ORDER  BY "createdAt" ASC
        LIMIT  1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, "providerId"
    `;

    if (!rows.length) return null;
    return { jobId: rows[0].id, providerId: rows[0].providerId };
  }

  async markRunning(jobId: string): Promise<void> {
    // Ya se hace en claimNextJob; este método existe para compatibilidad
    // con implementaciones futuras (BullMQ llama onActive separado).
    await this.prisma.extractionJob.update({
      where: { id: jobId },
      data: { startedAt: new Date() },
    });
  }

  async updateProgress(jobId: string, progress: number, totalProducts: number): Promise<void> {
    await this.prisma.extractionJob.update({
      where: { id: jobId },
      data: { progress, totalProducts, updatedAt: new Date() },
    });
  }

  async markCompleted(jobId: string, result: JobResult): Promise<void> {
    await this.prisma.extractionJob.update({
      where: { id: jobId },
      data: {
        status: "COMPLETED",
        finishedAt: new Date(),
        progress: 100,
        totalProducts: result.totalProducts,
        productsWithPrice: result.productsWithPrice,
        productsWithoutPrice: result.productsWithoutPrice,
        productsWithoutSku: result.productsWithoutSku,
        excelFilePath: result.excelFilePath,
        excelFileUrl: result.excelFileUrl,
        workerLockedAt: null,
        updatedAt: new Date(),
      },
    });
  }

  async markFailed(jobId: string, errorMessage: string): Promise<void> {
    await this.prisma.extractionJob.update({
      where: { id: jobId },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorMessage,
        workerLockedAt: null,
        updatedAt: new Date(),
      },
    });
  }

  /**
   * Libera jobs que quedaron en RUNNING porque el worker murió.
   * Los vuelve a PENDING para que otro worker los retome.
   */
  async releaseStaleJobs(staleAfterMs = 10 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - staleAfterMs);
    const result = await this.prisma.extractionJob.updateMany({
      where: {
        status: "RUNNING",
        workerLockedAt: { lt: cutoff },
      },
      data: {
        status: "PENDING",
        workerLockedAt: null,
        workerPid: null,
        startedAt: null,
        errorMessage: null,
      },
    });
    return result.count;
  }
}
