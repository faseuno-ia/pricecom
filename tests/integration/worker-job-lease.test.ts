// 2G-R8-Q1 · Integration (PostgreSQL efímero en CI) — lease heartbeat CAS + terminal fencing +
// stale reclaim + round-trip de precisión del timestamp. Evidencia safety-critical real (§11).
import "../setup/env";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, truncateAll } from "../setup/db";
import { createTestProvider, createTestUser } from "../helpers/factories";
import { DbPollingQueue } from "../../worker/src/queues/db-polling-queue";

const queue = new DbPollingQueue(testPrisma);

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
