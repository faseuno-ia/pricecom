import { PrismaClient } from "@prisma/client";
import type { IJobQueue, JobInspection, JobPayload, JobResult, LeaseRenewResult } from "./job-queue.interface";

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
    const rows = await this.prisma.$queryRaw<{ id: string; providerId: string; workerLockedAt: Date }[]>`
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
      RETURNING id, "providerId", "workerLockedAt"
    `;

    if (!rows.length) return null;
    // leaseVersion = workerLockedAt (timestamp(3), ms). Prisma lo devuelve como Date ms → round-trip exacto.
    return { jobId: rows[0].id, providerId: rows[0].providerId, leaseVersion: rows[0].workerLockedAt };
  }

  /**
   * NEON-GATE2A-EXEC-2 · CLAIM DIRIGIDO por jobId.
   *
   * Misma forma atómica que claimNextJob —UPDATE … WHERE id = (SELECT … FOR UPDATE SKIP LOCKED)
   * … RETURNING— con el predicado de selección acotado a UN id. ORDER BY/LIMIT dejan de ser
   * necesarios: la selección es por PK, devuelve 0 ó 1 fila por construcción, y el índice
   * ExtractionJob_pkey ya la soporta.
   *
   * SKIP LOCKED sigue haciendo falta: si otra transacción tiene la fila, devuelve 0 filas de
   * inmediato (→ JOB_NOT_RECLAIMABLE) en vez de bloquear la request contra su timeout.
   *
   * El filtro de source se conserva: los jobs sintéticos de POST /api/catalog/import nunca se
   * ejecutan acá.
   */
  async claimJob(jobId: string): Promise<JobPayload | null> {
    const rows = await this.prisma.$queryRaw<{ id: string; providerId: string; workerLockedAt: Date }[]>`
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
        WHERE  id = ${jobId}
        AND    status = 'PENDING'
        AND    ("source" IS NULL OR "source" <> 'IMPORT')
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, "providerId", "workerLockedAt"
    `;

    if (!rows.length) return null;
    return { jobId: rows[0].id, providerId: rows[0].providerId, leaseVersion: rows[0].workerLockedAt };
  }

  /**
   * NEON-GATE2A-EXEC-2 · claim del FALLBACK legacy, con VENTANA DE ATENCIÓN.
   *
   * Idéntico al claim FIFO histórico salvo por un predicado extra: `createdAt` dentro de la
   * ventana. Un PENDING más viejo que eso NUNCA lo toma el fallback — requiere redispatch humano
   * explícito, igual que en el modo wake. Es lo que impide que el interruptor de emergencia
   * reintroduzca el GLOBAL_DRAIN: procesa trabajo ATENDIDO y reciente, nunca trabajo abandonado.
   */
  async claimNextAttendedJob(attendedWindowMs: number): Promise<JobPayload | null> {
    const cutoff = new Date(Date.now() - attendedWindowMs);
    const rows = await this.prisma.$queryRaw<{ id: string; providerId: string; workerLockedAt: Date }[]>`
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
        AND    "createdAt" > ${cutoff}
        ORDER  BY "createdAt" ASC
        LIMIT  1
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, "providerId", "workerLockedAt"
    `;

    if (!rows.length) return null;
    return { jobId: rows[0].id, providerId: rows[0].providerId, leaseVersion: rows[0].workerLockedAt };
  }

  /**
   * NEON-GATE2A-EXEC-2 · ¿hay una ejecución viva para este job?
   *
   * Sólo TESTIGO de detección (STUCK_BUSY_SUSPECTED). Nunca muta nada ni resetea el estado local.
   */
  async isRunningLeaseAlive(jobId: string, thresholdMs: number): Promise<boolean> {
    const cutoff = new Date(Date.now() - thresholdMs);
    const n = await this.prisma.extractionJob.count({
      where: { id: jobId, status: "RUNNING", workerLockedAt: { gt: cutoff } },
    });
    return n > 0;
  }

  /**
   * 2G-R8-Q1 · Heartbeat CAS: renueva workerLockedAt SÓLO si seguimos siendo dueños. Statement único,
   * transacción propia (NOW() = tiempo del statement → versión avanza y es única). RETURNING trae la
   * nueva versión atómicamente. 0 filas → LOST. Un throw de DB → UNKNOWN (ownership indeterminado).
   */
  async renewLease(jobId: string, expectedLeaseVersion: Date): Promise<LeaseRenewResult> {
    try {
      const rows = await this.prisma.$queryRaw<{ workerLockedAt: Date }[]>`
        UPDATE "ExtractionJob"
        SET "workerLockedAt" = NOW(), "updatedAt" = NOW()
        WHERE id = ${jobId} AND status = 'RUNNING' AND "workerLockedAt" = ${expectedLeaseVersion}
        RETURNING "workerLockedAt"
      `;
      if (rows.length === 1) return { kind: "OWNED", leaseVersion: rows[0].workerLockedAt };
      return { kind: "LOST" };
    } catch {
      return { kind: "UNKNOWN" };
    }
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

  async markCompleted(jobId: string, result: JobResult, expectedLeaseVersion: Date): Promise<boolean> {
    // CAS fenced: updateMany permite el predicado de ownership (id no es único-compuesto). Sólo
    // terminalizamos si seguimos siendo dueños; 0 filas → el nuevo dueño no se sobrescribe.
    const { count } = await this.prisma.extractionJob.updateMany({
      where: { id: jobId, status: "RUNNING", workerLockedAt: expectedLeaseVersion },
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
        excelData: result.excelData,
        excelName: result.excelName,
        workerLockedAt: null,
        updatedAt: new Date(),
      },
    });
    return count === 1;
  }

  async markFailed(jobId: string, errorMessage: string, expectedLeaseVersion: Date): Promise<boolean> {
    const { count } = await this.prisma.extractionJob.updateMany({
      where: { id: jobId, status: "RUNNING", workerLockedAt: expectedLeaseVersion },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        errorMessage,
        workerLockedAt: null,
        updatedAt: new Date(),
      },
    });
    return count === 1;
  }

  /**
   * NEON-GATE2A-EXEC-2 · STALE RECOVERY PEREZOSA, acotada a UN jobId.
   *
   * Reemplaza el barrido periódico como camino productivo: se evalúa bajo demanda, en el momento
   * en que un humano decide recuperar ESE job.
   *
   * Dos diferencias que no son cosméticas frente a releaseStaleJobs:
   *
   *   1. El predicado de staleness se re-verifica DENTRO de la misma sentencia (no leer-y-después-
   *      escribir): si el ejecutor revivió y renovó el lease entremedio, el UPDATE afecta 0 filas
   *      y no le pisamos el job a nadie.
   *
   *   2. PRESERVA `startedAt` (y `errorMessage`). El barrido global los NULEA, y eso vuelve un job
   *      "reclamado-y-muerto" INDISTINGUIBLE de uno "nunca reclamado":
   *          PENDING ∧ startedAt IS NULL      → nunca arrancó   (PENDING_NO_TOMADO)
   *          PENDING ∧ startedAt IS NOT NULL  → arrancó y murió (RUNNING_INTERRUPTED recuperado)
   *      Destruir esa evidencia es destruir la clasificación que el operador necesita.
   *
   * @returns true si ESTE job fue liberado; false si ya no estaba stale (o no existía).
   */
  /**
   * NEON-GATE2A-EXEC-2-F1 · Lectura pura: NUNCA muta. La decisión de liberar es del handler, y la
   * autoridad sobre si la fila sigue stale es del UPDATE de `releaseStaleJob`, no de esta foto.
   */
  async inspectJob(jobId: string, liveLeaseThresholdMs: number): Promise<JobInspection | null> {
    const row = await this.prisma.extractionJob.findUnique({
      where: { id: jobId },
      select: { status: true, workerLockedAt: true },
    });
    if (!row) return null;
    const cutoff = Date.now() - liveLeaseThresholdMs;
    return {
      status: row.status,
      leaseAlive:
        row.status === "RUNNING" &&
        row.workerLockedAt !== null &&
        row.workerLockedAt.getTime() > cutoff,
    };
  }

  async releaseStaleJob(jobId: string, staleAfterMs: number): Promise<boolean> {
    const cutoff = new Date(Date.now() - staleAfterMs);
    const { count } = await this.prisma.extractionJob.updateMany({
      where: { id: jobId, status: "RUNNING", workerLockedAt: { lt: cutoff } },
      data: {
        status: "PENDING",
        workerLockedAt: null,
        workerPid: null,
        // startedAt y errorMessage NO se tocan: son la evidencia del intento previo.
        updatedAt: new Date(),
      },
    });
    return count === 1;
  }

  /**
   * Libera jobs que quedaron en RUNNING porque el worker murió.
   * Los vuelve a PENDING para que otro worker los retome.
   *
   * NEON-GATE2A-EXEC-2 · SIN CALL SITE PRODUCTIVO. El barrido periódico murió con el poll loop y
   * su función quedó re-alojada en `releaseStaleJob(jobId, …)`. Se conserva porque
   * tests/integration/worker-job-lease.test.ts lo ejercita como regresión del lease.
   * NO reusarlo para RUNNING_INTERRUPTED: nulea startedAt y destruye la evidencia.
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
