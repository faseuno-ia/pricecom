// 2G-R8-Q1 · Integration (PostgreSQL efímero en CI) — lease heartbeat CAS + terminal fencing +
// stale reclaim + round-trip de precisión del timestamp. Evidencia safety-critical real (§11).
import "../setup/env";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { testPrisma, truncateAll } from "../setup/db";
import { createTestProvider, createTestUser } from "../helpers/factories";
import { DbPollingQueue } from "../../worker/src/queues/db-polling-queue";

const queue = new DbPollingQueue(testPrisma);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function newPendingJob() {
  const user = await createTestUser();
  const provider = await createTestProvider(user.id, {});
  const job = await testPrisma.extractionJob.create({
    data: { providerId: provider.id, userId: user.id, status: "PENDING" },
  });
  return { job, provider, user };
}

describe("2G-R8-Q1 · DbPollingQueue lease/fencing (Postgres real)", () => {
  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await testPrisma.$disconnect(); });

  it("claim devuelve leaseVersion == workerLockedAt persistido (round-trip de precisión ms)", async () => {
    const { job } = await newPendingJob();
    const payload = await queue.claimNextJob();
    expect(payload?.jobId).toBe(job.id);
    expect(payload!.leaseVersion).toBeInstanceOf(Date);
    const row = await testPrisma.extractionJob.findUniqueOrThrow({ where: { id: job.id }, select: { workerLockedAt: true, status: true } });
    expect(row.status).toBe("RUNNING");
    // TIMESTAMP_ROUNDTRIP_CAS_RELIABLE: el lease del claim == la columna leída de vuelta (misma precisión).
    expect(payload!.leaseVersion.getTime()).toBe(row.workerLockedAt!.getTime());
  });

  it("renewLease OWNED avanza la versión; con versión equivocada → LOST", async () => {
    const { job } = await newPendingJob();
    const p = await queue.claimNextJob();
    const v0 = p!.leaseVersion;
    // pequeño gap para que NOW() avance ≥1ms
    await new Promise((r) => setTimeout(r, 5));
    const owned = await queue.renewLease(job.id, v0);
    expect(owned.kind).toBe("OWNED");
    if (owned.kind === "OWNED") {
      expect(owned.leaseVersion.getTime()).toBeGreaterThanOrEqual(v0.getTime());
      const row = await testPrisma.extractionJob.findUniqueOrThrow({ where: { id: job.id }, select: { workerLockedAt: true } });
      expect(owned.leaseVersion.getTime()).toBe(row.workerLockedAt!.getTime());
    }
    // versión vieja (v0) ya no matchea → LOST
    const lost = await queue.renewLease(job.id, v0);
    expect(lost.kind).toBe("LOST");
  });

  it("§H.9 · cadena de 2+ renovaciones consecutivas reales (DATABASE NOW + RETURNING): v0→v1→v2 estrictamente creciente y == columna DB", async () => {
    const { job } = await newPendingJob();
    const p = await queue.claimNextJob();
    const v0 = p!.leaseVersion;

    // Renovación 1: CAS contra v0 → v1 (NOW() del servidor, devuelto atómicamente).
    await sleep(3);
    const r1 = await queue.renewLease(job.id, v0);
    expect(r1.kind).toBe("OWNED");
    if (r1.kind !== "OWNED") return;
    const v1 = r1.leaseVersion;
    const dbAfter1 = await testPrisma.extractionJob.findUniqueOrThrow({ where: { id: job.id }, select: { workerLockedAt: true } });
    expect(v1.getTime()).toBe(dbAfter1.workerLockedAt!.getTime()); // el RETURNING == la columna persistida
    expect(v1.getTime()).toBeGreaterThan(v0.getTime());            // avanzó por NOW(), no por reloj de proceso

    // Renovación 2: CAS contra v1 (la versión ACTUAL, no v0) → v2. Prueba que el heartbeat encadena
    // sobre el valor devuelto por la renovación previa por el camino NOW()+RETURNING.
    await sleep(3);
    const r2 = await queue.renewLease(job.id, v1);
    expect(r2.kind).toBe("OWNED");
    if (r2.kind !== "OWNED") return;
    const v2 = r2.leaseVersion;
    const dbAfter2 = await testPrisma.extractionJob.findUniqueOrThrow({ where: { id: job.id }, select: { workerLockedAt: true } });
    expect(v2.getTime()).toBe(dbAfter2.workerLockedAt!.getTime());
    expect(v2.getTime()).toBeGreaterThan(v1.getTime());

    // Un CAS contra v0 (dos versiones atrás) sigue siendo LOST → sin ventana de re-uso de versión vieja.
    const stale = await queue.renewLease(job.id, v0);
    expect(stale.kind).toBe("LOST");
  });

  it("releaseStaleJobs re-encola un job cuyo lease venció (dead worker)", async () => {
    const { job } = await newPendingJob();
    await queue.claimNextJob();
    // envejecer el lock artificialmente
    await testPrisma.extractionJob.update({ where: { id: job.id }, data: { workerLockedAt: new Date(Date.now() - 20 * 60 * 1000) } });
    const released = await queue.releaseStaleJobs(10 * 60 * 1000);
    expect(released).toBe(1);
    const row = await testPrisma.extractionJob.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, workerLockedAt: true } });
    expect(row.status).toBe("PENDING");
    expect(row.workerLockedAt).toBeNull();
  });

  it("live long job: renovar el lease evita que releaseStaleJobs lo re-encole", async () => {
    const { job } = await newPendingJob();
    const p = await queue.claimNextJob();
    // envejecer, luego renovar (heartbeat) → workerLockedAt fresco
    await testPrisma.extractionJob.update({ where: { id: job.id }, data: { workerLockedAt: new Date(Date.now() - 20 * 60 * 1000) } });
    const cur = await testPrisma.extractionJob.findUniqueOrThrow({ where: { id: job.id }, select: { workerLockedAt: true } });
    const renewed = await queue.renewLease(job.id, cur.workerLockedAt!);
    expect(renewed.kind).toBe("OWNED");
    const released = await queue.releaseStaleJobs(10 * 60 * 1000);
    expect(released).toBe(0);
    const row = await testPrisma.extractionJob.findUniqueOrThrow({ where: { id: job.id }, select: { status: true } });
    expect(row.status).toBe("RUNNING");
  });

  it("terminal fencing: el OLD owner no puede marcar terminal tras un reclaim; el NEW owner sí", async () => {
    const { job } = await newPendingJob();
    const a = await queue.claimNextJob();
    const leaseA = a!.leaseVersion;
    // simular reclaim: volver a PENDING y re-claim (owner B con lease nuevo)
    await testPrisma.extractionJob.update({ where: { id: job.id }, data: { status: "PENDING", workerLockedAt: null, startedAt: null } });
    await new Promise((r) => setTimeout(r, 5));
    const b = await queue.claimNextJob();
    const leaseB = b!.leaseVersion;
    expect(leaseB.getTime()).not.toBe(leaseA.getTime());
    // A (viejo) intenta terminalizar con leaseA → suprimido
    const aCompleted = await queue.markCompleted(job.id, { totalProducts: 0, productsWithPrice: 0, productsWithoutPrice: 0, productsWithoutSku: 0, excelFilePath: null, excelFileUrl: null, excelData: null, excelName: null }, leaseA);
    expect(aCompleted).toBe(false);
    const aFailed = await queue.markFailed(job.id, "old owner error", leaseA);
    expect(aFailed).toBe(false);
    // el job sigue RUNNING (owned by B)
    const mid = await testPrisma.extractionJob.findUniqueOrThrow({ where: { id: job.id }, select: { status: true } });
    expect(mid.status).toBe("RUNNING");
    // B (dueño real) sí terminaliza
    const bCompleted = await queue.markCompleted(job.id, { totalProducts: 3, productsWithPrice: 3, productsWithoutPrice: 0, productsWithoutSku: 0, excelFilePath: null, excelFileUrl: null, excelData: null, excelName: null }, leaseB);
    expect(bCompleted).toBe(true);
    const done = await testPrisma.extractionJob.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, totalProducts: true, workerLockedAt: true } });
    expect(done.status).toBe("COMPLETED");
    expect(done.totalProducts).toBe(3);
    expect(done.workerLockedAt).toBeNull();
  });
});

// §H.10 · Row lock REAL (dos conexiones): la finalización fenced mantiene el lock de fila → un
// releaseStaleJobs concurrente BLOQUEA, y al re-evaluar tras el commit ve status=COMPLETED → 0 filas.
// No es una consulta sintética: usa un segundo PrismaClient y solapamiento temporal real.
describe("2G-R8-Q1-R1 · row lock vs releaseStaleJobs (dos conexiones Postgres)", () => {
  const clientB = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL_TEST } }, log: ["error"] });
  const queueB = new DbPollingQueue(clientB);

  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await clientB.$disconnect(); });

  it("la finalización fenced (tx abierta, lock de fila) hace que releaseStaleJobs concurrente NO re-encole un job que commitea COMPLETED", async () => {
    // Job RUNNING con lock VIEJO → sería candidato a stale-reclaim si no fuera por el lock + la re-evaluación.
    const user = await createTestUser();
    const provider = await createTestProvider(user.id, {});
    const job = await testPrisma.extractionJob.create({
      data: { providerId: provider.id, userId: user.id, status: "RUNNING", workerLockedAt: new Date(Date.now() - 30 * 60 * 1000) },
    });

    let releasedCount = -1;
    let bPromise: Promise<void> | undefined;
    // Cliente A: tx interactiva que finaliza (COMPLETED, lease liberado) y MANTIENE el lock de fila
    // mientras el cliente B intenta el stale-reclaim.
    await testPrisma.$transaction(async (txA) => {
      await txA.$executeRaw`
        UPDATE "ExtractionJob"
        SET status = 'COMPLETED', "workerLockedAt" = NULL, "finishedAt" = NOW(), "updatedAt" = NOW()
        WHERE id = ${job.id}`;
      // B arranca AHORA (otra conexión): su updateMany (WHERE status='RUNNING' AND workerLockedAt<cutoff)
      // intenta lockear la misma fila → BLOQUEA contra txA. No await todavía: lo dejamos estacionado.
      bPromise = queueB.releaseStaleJobs(10 * 60 * 1000).then((c) => { releasedCount = c; });
      await sleep(400); // B alcanza la espera de lock; el count sigue -1 (aún bloqueado)
      expect(releasedCount).toBe(-1);
      // al retornar, txA commitea → B se desbloquea y re-evalúa la fila (ahora COMPLETED)
    }, { timeout: 10000 });

    await bPromise;
    expect(releasedCount).toBe(0); // re-evaluó: status=COMPLETED ≠ RUNNING → no re-encola
    const row = await testPrisma.extractionJob.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, workerLockedAt: true } });
    expect(row.status).toBe("COMPLETED");
    expect(row.workerLockedAt).toBeNull();
  });
});

// §D.2 · Benchmark empírico (SANITY, RTT≈0 en CI): la finalización PRICE_ONLY con 1121 updates
// secuenciales dentro de UNA tx no tiene un problema intrínseco absurdo — completa muy por debajo
// del timeout de 120s. NO paga el gate productivo por sí solo (ver §D.3/§D.4: la evidencia
// Railway→Neon es la que decide); es un piso de sanidad.
describe("2G-R8-Q1-R1 · benchmark finalización PRICE_ONLY 1121 writes (sanity local)", () => {
  beforeEach(async () => { await truncateAll(); });

  it("1121 catalogProduct.update secuenciales en una tx completan < 120000ms (timeout Prisma)", async () => {
    const N = 1121;
    const user = await createTestUser();
    const provider = await createTestProvider(user.id, {});
    // Seed catálogo existente (1121 filas) en bulk.
    await testPrisma.catalogProduct.createMany({
      data: Array.from({ length: N }, (_, i) => ({ userId: user.id, providerId: provider.id, sku: `BM-${i}`, supplierName: provider.name, lastSeenAt: new Date(), wholesalePrice: 10 })),
    });
    const rows = await testPrisma.catalogProduct.findMany({ where: { providerId: provider.id }, select: { id: true } });
    expect(rows.length).toBe(N);

    const t0 = Date.now();
    await testPrisma.$transaction(async (tx) => {
      for (const r of rows) {
        await tx.catalogProduct.update({ where: { id: r.id }, data: { wholesalePrice: 20, lastSeenAt: new Date() } });
      }
    }, { timeout: 120000, maxWait: 15000 });
    const elapsed = Date.now() - t0;
    // eslint-disable-next-line no-console
    console.log(`[BENCHMARK] PRICE_ONLY ${N} updates en una tx: ${elapsed}ms (RTT≈0, sanity)`);
    expect(elapsed).toBeLessThan(120000);
  });
});
