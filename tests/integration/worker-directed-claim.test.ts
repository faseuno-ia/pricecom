// NEON-GATE2A-EXEC-2 · Integration (Postgres real) — semántica SQL del claim dirigido, del claim
// con ventana de atención y del release stale perezoso.
//
// Lo que se prueba acá NO se puede probar offline: el filtro de `source`, la comparación de
// `createdAt` contra un intervalo calculado por el servidor, la preservación de columnas en el
// UPDATE, y que el predicado de staleness se re-verifique DENTRO de la misma sentencia. La cola
// falsa de tests/unit/wake-server.test.ts imita esta semántica; este archivo es el que verifica
// que la imitación corresponde a algo real.
import "../setup/env";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, truncateAll } from "../setup/db";
import { createTestProvider, createTestUser } from "../helpers/factories";
import { DbPollingQueue } from "../../worker/src/queues/db-polling-queue";

const queue = new DbPollingQueue(testPrisma);

async function newJob(opts: { source?: string | null; createdAt?: Date; status?: string } = {}) {
  const user = await createTestUser();
  const provider = await createTestProvider(user.id, {});
  const job = await testPrisma.extractionJob.create({
    data: {
      providerId: provider.id,
      userId: user.id,
      status: (opts.status ?? "PENDING") as never,
      ...(opts.source !== undefined ? { source: opts.source } : {}),
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    },
  });
  return { job, provider, user };
}

describe("NEON-GATE2A-EXEC-2 · claim dirigido (Postgres real)", () => {
  beforeEach(async () => {
    await truncateAll();
  });
  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it("directed_claim_takes_only_the_requested_job", async () => {
    const { job: older } = await newJob({ createdAt: new Date(Date.now() - 60 * 60 * 1000) });
    const { job: target } = await newJob();

    const payload = await queue.claimJob(target.id);

    expect(payload?.jobId).toBe(target.id);
    expect(payload!.leaseVersion).toBeInstanceOf(Date);
    // El job MÁS VIEJO —el que un claim global habría elegido primero— queda intacto.
    const untouched = await testPrisma.extractionJob.findUniqueOrThrow({
      where: { id: older.id },
      select: { status: true, workerLockedAt: true },
    });
    expect(untouched.status).toBe("PENDING");
    expect(untouched.workerLockedAt).toBeNull();
  });

  it("directed_claim_is_not_repeatable_for_the_same_job", async () => {
    const { job } = await newJob();

    const first = await queue.claimJob(job.id);
    const second = await queue.claimJob(job.id);

    expect(first?.jobId).toBe(job.id);
    // Ya no es PENDING ⇒ el segundo wake al mismo job no puede producir una segunda ejecución.
    expect(second).toBeNull();
  });

  it("directed_claim_never_takes_import_source_jobs", async () => {
    const { job: imported } = await newJob({ source: "IMPORT" });
    const { job: normal } = await newJob({ source: null });

    expect(await queue.claimJob(imported.id)).toBeNull();
    // Control positivo: la fila existe y sigue PENDING — el null es por el filtro de source, no
    // porque el job no exista o el claim esté roto.
    const row = await testPrisma.extractionJob.findUniqueOrThrow({
      where: { id: imported.id },
      select: { status: true },
    });
    expect(row.status).toBe("PENDING");
    expect((await queue.claimJob(normal.id))?.jobId).toBe(normal.id);
  });

  it("fallback_never_claims_jobs_older_than_attended_window", async () => {
    const WINDOW = 2 * 60 * 1000;
    const { job: abandoned } = await newJob({ createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) });

    // Con SÓLO trabajo abandonado, el fallback no encuentra nada: no reintroduce drain global.
    expect(await queue.claimNextAttendedJob(WINDOW)).toBeNull();

    // Control positivo con el MISMO umbral: un job reciente sí se toma. Sin esto, el null de
    // arriba sería compatible con "claimNextAttendedJob no reclama nunca".
    const { job: recent } = await newJob();
    expect((await queue.claimNextAttendedJob(WINDOW))?.jobId).toBe(recent.id);

    const still = await testPrisma.extractionJob.findUniqueOrThrow({
      where: { id: abandoned.id },
      select: { status: true },
    });
    expect(still.status).toBe("PENDING");
  });

  it("stale_release_targets_only_requested_job", async () => {
    const a = (await newJob()).job;
    const b = (await newJob()).job;
    await queue.claimJob(a.id);
    await queue.claimJob(b.id);
    const past = new Date(Date.now() - 60 * 60 * 1000);
    await testPrisma.extractionJob.updateMany({
      where: { id: { in: [a.id, b.id] } },
      data: { workerLockedAt: past },
    });

    const released = await queue.releaseStaleJob(a.id, 10 * 60 * 1000);

    expect(released).toBe(true);
    const rowA = await testPrisma.extractionJob.findUniqueOrThrow({
      where: { id: a.id },
      select: { status: true },
    });
    const rowB = await testPrisma.extractionJob.findUniqueOrThrow({
      where: { id: b.id },
      select: { status: true },
    });
    expect(rowA.status).toBe("PENDING");
    // b está igual de stale que a, pero NO se pidió: la recuperación es perezosa y acotada.
    expect(rowB.status).toBe("RUNNING");
  });

  it("stale_release_preserves_started_at", async () => {
    const { job } = await newJob();
    await queue.claimJob(job.id);
    await queue.markRunning(job.id);
    const before = await testPrisma.extractionJob.findUniqueOrThrow({
      where: { id: job.id },
      select: { startedAt: true },
    });
    expect(before.startedAt).not.toBeNull();
    await testPrisma.extractionJob.update({
      where: { id: job.id },
      data: { workerLockedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });

    expect(await queue.releaseStaleJob(job.id, 10 * 60 * 1000)).toBe(true);

    const after = await testPrisma.extractionJob.findUniqueOrThrow({
      where: { id: job.id },
      select: { startedAt: true, status: true },
    });
    expect(after.status).toBe("PENDING");
    // startedAt es evidencia forense del intento que murió: liberar el lease no la borra.
    expect(after.startedAt?.getTime()).toBe(before.startedAt!.getTime());
  });

  it("stale_release_refuses_a_job_whose_lease_is_still_fresh", async () => {
    const { job } = await newJob();
    await queue.claimJob(job.id);

    // El lease acaba de renovarse ⇒ el predicado de staleness se re-verifica en la MISMA
    // sentencia y no libera. Sin esto, una carrera contra el heartbeat robaría un job vivo.
    expect(await queue.releaseStaleJob(job.id, 10 * 60 * 1000)).toBe(false);

    const row = await testPrisma.extractionJob.findUniqueOrThrow({
      where: { id: job.id },
      select: { status: true },
    });
    expect(row.status).toBe("RUNNING");
  });

  it("is_running_lease_alive_is_a_read_only_witness", async () => {
    const { job } = await newJob();
    await queue.claimJob(job.id);

    expect(await queue.isRunningLeaseAlive(job.id, 4 * 60 * 1000)).toBe(true);

    await testPrisma.extractionJob.update({
      where: { id: job.id },
      data: { workerLockedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    expect(await queue.isRunningLeaseAlive(job.id, 4 * 60 * 1000)).toBe(false);

    // El testigo NO muta: sigue RUNNING después de observarlo muerto. Quien decide es el handler.
    const row = await testPrisma.extractionJob.findUniqueOrThrow({
      where: { id: job.id },
      select: { status: true },
    });
    expect(row.status).toBe("RUNNING");
  });
  it("inspect_job_reports_status_and_lease_liveness_without_mutating", async () => {
    const { job } = await newJob();

    // PENDING: no hay lease que pueda estar vivo.
    const pending = await queue.inspectJob(job.id, 4 * 60 * 1000);
    expect(pending).toEqual({ status: "PENDING", leaseAlive: false });

    await queue.claimJob(job.id);
    expect(await queue.inspectJob(job.id, 4 * 60 * 1000)).toEqual({
      status: "RUNNING",
      leaseAlive: true,
    });

    // Lease vencido: es el huérfano de F1 — RUNNING, pero nadie lo está corriendo.
    await testPrisma.extractionJob.update({
      where: { id: job.id },
      data: { workerLockedAt: new Date(Date.now() - 60 * 60 * 1000) },
    });
    expect(await queue.inspectJob(job.id, 4 * 60 * 1000)).toEqual({
      status: "RUNNING",
      leaseAlive: false,
    });

    // La foto NO muta: la autoridad para liberar es del UPDATE de releaseStaleJob, no de esta
    // lectura. Y un job inexistente devuelve null, no una foto inventada.
    const row = await testPrisma.extractionJob.findUniqueOrThrow({
      where: { id: job.id },
      select: { status: true, startedAt: true },
    });
    expect(row.status).toBe("RUNNING");
    expect(row.startedAt).not.toBeNull();
    expect(await queue.inspectJob("no-existe", 4 * 60 * 1000)).toBeNull();
  });

});
