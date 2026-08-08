// 2G-R8-Q1-R1 · Integration (PostgreSQL real) — Excel como artefacto POST-COMMIT best-effort.
// Contrato congelado: un fallo del Excel NO revierte precios y NO cambia un job COMPLETED → FAILED.
// Cubre F.1–F.5 del addendum Q1-R1.
import "../setup/env";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtractedProduct, Provider } from "@prisma/client";
import { testPrisma, truncateAll } from "../setup/db";
import { createTestProvider, createTestUser } from "../helpers/factories";
import { attachExcelPostCommit, type ExcelArtifact, type LogLevel } from "../../worker/src/attach-excel";
import { DbPollingQueue } from "../../worker/src/queues/db-polling-queue";

const okExcel = (buf = Buffer.from("xlsx-bytes")): ExcelArtifact => ({ buffer: buf, filename: "reporte.xlsx", fileUrl: "/api/extractions/download/reporte.xlsx" });
const genOk = vi.fn(async (_p: ExtractedProduct[], _prov: Provider, _job: string): Promise<ExcelArtifact> => okExcel());
const genThrows = vi.fn(async (): Promise<ExcelArtifact> => { throw new Error("ExcelJS boom"); });

function capture() {
  const logs: { level: LogLevel; message: string }[] = [];
  const onLog = (level: LogLevel, message: string) => { logs.push({ level, message }); };
  return { logs, onLog };
}

async function newJob(status: "PENDING" | "RUNNING" | "COMPLETED", data: Record<string, unknown> = {}) {
  const user = await createTestUser();
  const provider = await createTestProvider(user.id, {});
  const job = await testPrisma.extractionJob.create({
    data: { providerId: provider.id, userId: user.id, status, ...data },
  });
  return { job, provider, user };
}

describe("2G-R8-Q1-R1 · Excel post-commit best-effort (Postgres real)", () => {
  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await testPrisma.$disconnect(); });

  it("F.1 · éxito post-commit: job COMPLETED con excelData adjuntado", async () => {
    const { job, provider } = await newJob("COMPLETED", { excelData: null, workerLockedAt: null });
    const { logs, onLog } = capture();
    const attached = await attachExcelPostCommit({ prisma: testPrisma, generateExcel: genOk, onLog }, { jobId: job.id, provider });
    expect(attached).toBe(true);
    const row = await testPrisma.extractionJob.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, excelData: true, excelName: true } });
    expect(row.status).toBe("COMPLETED");
    expect(row.excelData).not.toBeNull();
    expect(row.excelName).toBe("reporte.xlsx");
    expect(logs.some((l) => l.level === "INFO" && /adjuntado post-commit/i.test(l.message))).toBe(true);
  });

  it("F.2 · fallo post-commit: precios/producto preservados, job COMPLETED, excelData null, warning, cero markFailed, sin escape", async () => {
    const { job, provider } = await newJob("COMPLETED", { excelData: null, workerLockedAt: null });
    // Escritura comercial ya committeada (simula el estado tras el commit de la tx fenced).
    await testPrisma.extractedProduct.create({ data: { jobId: job.id, providerId: provider.id, name: "prod-1", sku: "SKU-1", wholesalePrice: 100 } });
    const { logs, onLog } = capture();
    // La promesa NO debe rechazar (la excepción NO escapa de la finalización).
    const attached = await attachExcelPostCommit({ prisma: testPrisma, generateExcel: genThrows, onLog }, { jobId: job.id, provider });
    expect(attached).toBe(false);
    const row = await testPrisma.extractionJob.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, excelData: true } });
    expect(row.status).toBe("COMPLETED"); // NO pasó a FAILED
    expect(row.excelData).toBeNull();
    const products = await testPrisma.extractedProduct.count({ where: { jobId: job.id } });
    expect(products).toBe(1); // el producto committeado sobrevive
    expect(logs.some((l) => l.level === "WARN" && /no afecta precios ni el estado COMPLETED/i.test(l.message))).toBe(true);
    expect(logs.some((l) => l.level === "ERROR")).toBe(false);
  });

  it("F.3 · predicado del attach: job NO COMPLETED → 0 filas, sin excepción", async () => {
    const { job, provider } = await newJob("RUNNING", { excelData: null });
    const { onLog } = capture();
    const attached = await attachExcelPostCommit({ prisma: testPrisma, generateExcel: genOk, onLog }, { jobId: job.id, provider });
    expect(attached).toBe(false);
    const row = await testPrisma.extractionJob.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, excelData: true } });
    expect(row.status).toBe("RUNNING"); // intacto
    expect(row.excelData).toBeNull();
  });

  it("F.4 · attach no pisa un Excel existente: COMPLETED con excelData != null → 0 filas", async () => {
    const existing = Buffer.from("excel-previo");
    const { job, provider } = await newJob("COMPLETED", { excelData: existing, excelName: "previo.xlsx", workerLockedAt: null });
    const { onLog } = capture();
    const attached = await attachExcelPostCommit({ prisma: testPrisma, generateExcel: genOk, onLog }, { jobId: job.id, provider });
    expect(attached).toBe(false);
    const row = await testPrisma.extractionJob.findUniqueOrThrow({ where: { id: job.id }, select: { excelName: true, excelData: true } });
    expect(row.excelName).toBe("previo.xlsx"); // NO sobrescrito
    expect(Buffer.from(row.excelData!).equals(existing)).toBe(true);
  });

  it("F.5 · post-commit sin lease: job COMPLETED + workerLockedAt NULL → releaseStaleJobs no lo toca", async () => {
    const queue = new DbPollingQueue(testPrisma);
    // Estado tras el commit de la tx fenced: COMPLETED, sin lease.
    const { job } = await newJob("COMPLETED", { excelData: null, workerLockedAt: null, finishedAt: new Date() });
    const row0 = await testPrisma.extractionJob.findUniqueOrThrow({ where: { id: job.id }, select: { status: true, workerLockedAt: true } });
    expect(row0.status).toBe("COMPLETED");
    expect(row0.workerLockedAt).toBeNull(); // POST_COMMIT_PHASE_HAS_NO_LEASE
    const released = await queue.releaseStaleJobs(10 * 60 * 1000);
    expect(released).toBe(0);
    const row1 = await testPrisma.extractionJob.findUniqueOrThrow({ where: { id: job.id }, select: { status: true } });
    expect(row1.status).toBe("COMPLETED"); // releaseStaleJobs sólo re-encola RUNNING; un COMPLETED es intocable
  });
});
