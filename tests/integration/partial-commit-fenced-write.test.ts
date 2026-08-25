// 2G-R8-Q2.1-B · Integration (PostgreSQL real) — atomicidad de la tx fenced (W15-W20),
// desacoplamiento ExtractedProduct↔write-set (W33/W34), write-set vacío (W35) y restore (§4).
import "../setup/env";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, truncateAll } from "../setup/db";
import { createTestUser } from "../helpers/factories";
import { fencedPartialWrite } from "../../worker/src/partial-commit-fenced-write";
import { buildCatalogSnapshot, type CatalogSnapshotRow } from "../../lib/catalog/catalog-snapshot-diff";
import { buildRestorePlan, type RestoreMutableRow } from "../../lib/catalog/restore-guard";
import type { ScrapedProduct } from "../../lib/scraper/scraper.service";

const noLog = async () => {};
const sp = (sku: string, price: number | null, url = `https://x/${sku}`): ScrapedProduct => ({
  sku, name: `N-${sku}`, description: null, wholesalePrice: price, oldPrice: null, stock: null,
  category: null, brand: null, productUrl: url, imageUrl: null, rawData: {},
});

async function seed(catalog: Array<{ sku: string; wholesalePrice: number | null }>) {
  const user = await createTestUser();
  const provider = await testPrisma.provider.create({
    data: { userId: user.id, name: `DT-${Date.now()}`, providerType: "SCRAPER", baseUrl: "https://x", skuPrefix: "", requiresLogin: true },
  });
  const job = await testPrisma.extractionJob.create({ data: { providerId: provider.id, userId: user.id, status: "RUNNING", workerLockedAt: new Date() } });
  // Usar el valor REALMENTE almacenado (post-truncación a timestamp(3)) como leaseVersion, igual que
  // en producción claimNextJob lee el workerLockedAt de la DB.
  const stored = await testPrisma.extractionJob.findUniqueOrThrow({ where: { id: job.id }, select: { workerLockedAt: true } });
  const lease = stored.workerLockedAt as Date;
  for (const c of catalog) {
    await testPrisma.catalogProduct.create({
      data: { userId: user.id, providerId: provider.id, sku: c.sku, wholesalePrice: c.wholesalePrice, supplierName: `N-${c.sku}`, lastSeenAt: new Date("2026-01-01T00:00:00Z"), internalStatus: "PREPARED", stockSource: "SUPPLIER" },
    });
  }
  return { user, provider, job, lease };
}

const priceOf = async (providerId: string, sku: string) => {
  const r = await testPrisma.catalogProduct.findFirstOrThrow({ where: { providerId, sku }, select: { wholesalePrice: true } });
  return r.wholesalePrice == null ? null : Number(r.wholesalePrice);
};
const epCount = (jobId: string) => testPrisma.extractedProduct.count({ where: { jobId } });
const jobStatus = async (jobId: string) => (await testPrisma.extractionJob.findUniqueOrThrow({ where: { id: jobId }, select: { status: true } })).status;
const stats = (n: number) => ({ totalProducts: n, productsWithPrice: 0, productsWithoutPrice: 0, productsWithoutSku: 0 });

// C2-MINI-A · el fenced write ahora exige UN instante de observación por attempt. Constante fija:
// estos tests no afirman nada sobre taxonomía, sólo necesitan satisfacer el contrato.
const ATTEMPT_OBSERVED_AT = new Date("2026-08-24T00:00:00.000Z");

describe("2G-R8-Q2.1-B · tx fenced atomicity (Postgres real)", () => {
  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await testPrisma.$disconnect(); });

  it("W15 · lease CAS falla (leaseVersion incorrecto) → rollback total, EP=0, job RUNNING", async () => {
    const { provider, job } = await seed([{ sku: "A", wholesalePrice: 100 }]);
    await expect(fencedPartialWrite(testPrisma, {
      jobId: job.id, userId: provider.userId, provider: { id: provider.id, userId: provider.userId, requiresLogin: true },
      leaseVersion: new Date(Date.now() - 999999), // NO coincide con job.workerLockedAt
      observations: [sp("A", 110)], priceWriteSkus: [{ sku: "A", newPrice: 110 }], completionStats: stats(1), onLog: noLog, attemptObservedAt: ATTEMPT_OBSERVED_AT,
    })).rejects.toThrow(/LEASE_FENCING_LOST/);
    expect(await priceOf(provider.id, "A")).toBe(100);
    expect(await epCount(job.id)).toBe(0);
    expect(await jobStatus(job.id)).toBe("RUNNING");
  });

  it("W16 · D bloquea (priced→null) → rollback total, EP=0, precio intacto, job RUNNING", async () => {
    const { provider, job, lease } = await seed([{ sku: "A", wholesalePrice: 100 }]);
    await expect(fencedPartialWrite(testPrisma, {
      jobId: job.id, userId: provider.userId, provider: { id: provider.id, userId: provider.userId, requiresLogin: true },
      leaseVersion: lease, observations: [sp("A", 0)], priceWriteSkus: [{ sku: "A", newPrice: 0 }], completionStats: stats(1), onLog: noLog, attemptObservedAt: ATTEMPT_OBSERVED_AT,
    })).rejects.toThrow(/PRE_WRITE_PRICE_REGRESSION/);
    expect(await priceOf(provider.id, "A")).toBe(100);
    expect(await epCount(job.id)).toBe(0);
    expect(await jobStatus(job.id)).toBe("RUNNING");
  });

  it("W17_JS_LEVEL · throw a mitad del loop de updates → rollback total (0 filas mutadas, EP=0)", async () => {
    const { provider, job, lease } = await seed([{ sku: "A", wholesalePrice: 100 }, { sku: "B", wholesalePrice: 50 }, { sku: "C", wholesalePrice: 80 }]);
    await expect(fencedPartialWrite(testPrisma, {
      jobId: job.id, userId: provider.userId, provider: { id: provider.id, userId: provider.userId, requiresLogin: true },
      leaseVersion: lease, observations: [sp("A", 110), sp("B", 55), sp("C", 88)],
      priceWriteSkus: [{ sku: "A", newPrice: 110 }, { sku: "B", newPrice: 55 }, { sku: "C", newPrice: 88 }],
      completionStats: stats(3), onLog: noLog, attemptObservedAt: ATTEMPT_OBSERVED_AT, faults: { throwAfterPriceUpdates: 2 },
    })).rejects.toThrow(/__TEST_FAULT_JS/);
    expect(await priceOf(provider.id, "A")).toBe(100);
    expect(await priceOf(provider.id, "B")).toBe(50);
    expect(await priceOf(provider.id, "C")).toBe(80);
    expect(await epCount(job.id)).toBe(0);
    expect(await jobStatus(job.id)).toBe("RUNNING");
  });

  it("W17_DB_LEVEL · excepción ORIGINADA POR POSTGRES durante el update → rollback (EP creado en la MISMA tx = 0)", async () => {
    const { provider, job, lease } = await seed([{ sku: "A", wholesalePrice: 100 }, { sku: "B", wholesalePrice: 50 }]);
    // trigger test-only que RAISE al actualizar sku='B' (NO toca el schema productivo).
    await testPrisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION __test_fault_b() RETURNS trigger AS $$ BEGIN IF NEW."sku" = 'B' THEN RAISE EXCEPTION 'test_db_fault_on_B'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;`);
    await testPrisma.$executeRawUnsafe(`CREATE TRIGGER __test_fault_b_trg BEFORE UPDATE ON "CatalogProduct" FOR EACH ROW EXECUTE FUNCTION __test_fault_b();`);
    try {
      await expect(fencedPartialWrite(testPrisma, {
        jobId: job.id, userId: provider.userId, provider: { id: provider.id, userId: provider.userId, requiresLogin: true },
        leaseVersion: lease, observations: [sp("A", 110), sp("B", 55)],
        priceWriteSkus: [{ sku: "A", newPrice: 110 }, { sku: "B", newPrice: 55 }], completionStats: stats(2), onLog: noLog, attemptObservedAt: ATTEMPT_OBSERVED_AT,
      })).rejects.toThrow(/test_db_fault_on_B/);
      expect(await priceOf(provider.id, "A")).toBe(100); // el update de A se revirtió también
      expect(await priceOf(provider.id, "B")).toBe(50);
      expect(await epCount(job.id)).toBe(0); // createMany EP corrió DENTRO de la misma tx → rollback
      expect(await jobStatus(job.id)).toBe("RUNNING");
    } finally {
      await testPrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS __test_fault_b_trg ON "CatalogProduct";`);
      await testPrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS __test_fault_b();`);
    }
  });

  it("W18 · fallo REAL de tx.provider.update() (trigger RAISE de Postgres) → rollback total", async () => {
    const { provider, job, lease } = await seed([{ sku: "A", wholesalePrice: 100 }]);
    await testPrisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION __test_fault_prov() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'test_provider_update_fault'; END; $$ LANGUAGE plpgsql;`);
    await testPrisma.$executeRawUnsafe(`CREATE TRIGGER __test_fault_prov_trg BEFORE UPDATE ON "Provider" FOR EACH ROW EXECUTE FUNCTION __test_fault_prov();`);
    try {
      await expect(fencedPartialWrite(testPrisma, {
        jobId: job.id, userId: provider.userId, provider: { id: provider.id, userId: provider.userId, requiresLogin: true },
        leaseVersion: lease, observations: [sp("A", 110)], priceWriteSkus: [{ sku: "A", newPrice: 110 }], completionStats: stats(1), onLog: noLog, attemptObservedAt: ATTEMPT_OBSERVED_AT,
      })).rejects.toThrow(/test_provider_update_fault/); // W18_PROVIDER_UPDATE_ACTUAL_FAILURE
      expect(await priceOf(provider.id, "A")).toBe(100); // CATALOG_ROLLBACK
      expect(await epCount(job.id)).toBe(0);             // EP_ROLLBACK
      expect(await jobStatus(job.id)).toBe("RUNNING");   // JOB_NOT_COMPLETED
    } finally {
      await testPrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS __test_fault_prov_trg ON "Provider";`);
      await testPrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS __test_fault_prov();`);
    }
  });

  it("W19 · fallo REAL de la escritura terminal COMPLETED (trigger RAISE) → rollback total (provider update REVERTIDO)", async () => {
    const { provider, job, lease } = await seed([{ sku: "A", wholesalePrice: 100 }]);
    // trigger que RAISE sólo cuando status pasa a COMPLETED (la CAS mantiene status=RUNNING → no dispara).
    await testPrisma.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION __test_fault_terminal() RETURNS trigger AS $$ BEGIN IF NEW.status='COMPLETED' THEN RAISE EXCEPTION 'test_terminal_fault'; END IF; RETURN NEW; END; $$ LANGUAGE plpgsql;`);
    await testPrisma.$executeRawUnsafe(`CREATE TRIGGER __test_fault_terminal_trg BEFORE UPDATE ON "ExtractionJob" FOR EACH ROW EXECUTE FUNCTION __test_fault_terminal();`);
    try {
      await expect(fencedPartialWrite(testPrisma, {
        jobId: job.id, userId: provider.userId, provider: { id: provider.id, userId: provider.userId, requiresLogin: true },
        leaseVersion: lease, observations: [sp("A", 110)], priceWriteSkus: [{ sku: "A", newPrice: 110 }], completionStats: stats(1), onLog: noLog, attemptObservedAt: ATTEMPT_OBSERVED_AT,
      })).rejects.toThrow(/test_terminal_fault/); // W19_TERMINAL_UPDATE_ACTUAL_FAILURE
      expect(await priceOf(provider.id, "A")).toBe(100); // CATALOG_ROLLBACK
      expect(await epCount(job.id)).toBe(0);             // EP_ROLLBACK
      const prov = await testPrisma.provider.findUniqueOrThrow({ where: { id: provider.id }, select: { lastExtractionAt: true } });
      expect(prov.lastExtractionAt).toBeNull();          // PROVIDER_UPDATE_ROLLED_BACK_WHEN_TERMINAL_FAILS
      expect(await jobStatus(job.id)).toBe("RUNNING");
    } finally {
      await testPrisma.$executeRawUnsafe(`DROP TRIGGER IF EXISTS __test_fault_terminal_trg ON "ExtractionJob";`);
      await testPrisma.$executeRawUnsafe(`DROP FUNCTION IF EXISTS __test_fault_terminal();`);
    }
  });

  it("W1/commit · éxito → precio escrito, EP=observaciones, job COMPLETED", async () => {
    const { provider, job, lease } = await seed([{ sku: "A", wholesalePrice: 100 }]);
    const r = await fencedPartialWrite(testPrisma, {
      jobId: job.id, userId: provider.userId, provider: { id: provider.id, userId: provider.userId, requiresLogin: true },
      leaseVersion: lease, observations: [sp("A", 110)], priceWriteSkus: [{ sku: "A", newPrice: 110 }], completionStats: { totalProducts: 1, productsWithPrice: 1, productsWithoutPrice: 0, productsWithoutSku: 0 }, onLog: noLog, attemptObservedAt: ATTEMPT_OBSERVED_AT,
    });
    expect(r.committed).toBe(true);
    expect(r.writtenCount).toBe(1);
    expect(await priceOf(provider.id, "A")).toBe(110);
    expect(await epCount(job.id)).toBe(1);
    expect(await jobStatus(job.id)).toBe("COMPLETED");
  });

  it("W33/W34 · M observaciones > N write-set: EP=M, precios escritos=N, SKUs nuevos no insertados", async () => {
    const { provider, job, lease } = await seed([{ sku: "A", wholesalePrice: 100 }, { sku: "B", wholesalePrice: 50 }]);
    await fencedPartialWrite(testPrisma, {
      jobId: job.id, userId: provider.userId, provider: { id: provider.id, userId: provider.userId, requiresLogin: true },
      leaseVersion: lease,
      observations: [sp("A", 110), sp("B", 55), sp("NUEVO1", 200), sp("NUEVO2", 300)], // M=4
      priceWriteSkus: [{ sku: "A", newPrice: 110 }, { sku: "B", newPrice: 55 }], // N=2
      completionStats: stats(4), onLog: noLog, attemptObservedAt: ATTEMPT_OBSERVED_AT,
    });
    expect(await epCount(job.id)).toBe(4); // M observaciones (Excel input = M)
    expect(await priceOf(provider.id, "A")).toBe(110);
    expect(await priceOf(provider.id, "B")).toBe(55);
    // SKUs nuevos NO insertados en el catálogo.
    expect(await testPrisma.catalogProduct.count({ where: { providerId: provider.id, sku: { in: ["NUEVO1", "NUEVO2"] } } })).toBe(0);
    expect(await testPrisma.catalogProduct.count({ where: { providerId: provider.id } })).toBe(2); // sólo los 2 originales
  });

  it("W35 · write-set vacío (N=0) con observaciones → tx abre, EP=M, 0 escrituras de precio, D no aplica, job COMPLETED", async () => {
    const { provider, job, lease } = await seed([{ sku: "A", wholesalePrice: 100 }]);
    const r = await fencedPartialWrite(testPrisma, {
      jobId: job.id, userId: provider.userId, provider: { id: provider.id, userId: provider.userId, requiresLogin: true },
      leaseVersion: lease, observations: [sp("A", null)], priceWriteSkus: [], completionStats: stats(1), onLog: noLog, attemptObservedAt: ATTEMPT_OBSERVED_AT,
    });
    expect(r.committed).toBe(true);
    expect(r.writtenCount).toBe(0);
    expect(await epCount(job.id)).toBe(1); // observación persistida (deliverable)
    expect(await priceOf(provider.id, "A")).toBe(100); // 0 escrituras de precio
    expect(await jobStatus(job.id)).toBe("COMPLETED");
  });
});

describe("2G-R8-Q2.1-B · restore (Postgres real, §4)", () => {
  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await testPrisma.$disconnect(); });

  const snapRows = async (providerId: string): Promise<CatalogSnapshotRow[]> => {
    const rows = await testPrisma.catalogProduct.findMany({ where: { providerId }, select: { id: true, sku: true, wholesalePrice: true, lastSeenAt: true, latestExtractedProductId: true, supplierName: true, supplierDescription: true, supplierCategory: true, imageUrl: true, productUrl: true, stock: true, supplierStatus: true, internalStatus: true, pausedBySystem: true } });
    return rows.map((r) => ({ id: r.id, sku: r.sku, wholesalePrice: r.wholesalePrice == null ? null : Number(r.wholesalePrice), lastSeenAt: r.lastSeenAt ? r.lastSeenAt.toISOString() : null, latestExtractedProductId: r.latestExtractedProductId, supplierName: r.supplierName, supplierDescription: r.supplierDescription, supplierCategory: r.supplierCategory, imageUrl: r.imageUrl, productUrl: r.productUrl, stock: r.stock, supplierStatus: r.supplierStatus, internalStatus: r.internalStatus, pausedBySystem: r.pausedBySystem }));
  };
  const mutable = (r: CatalogSnapshotRow): RestoreMutableRow => ({ id: r.id, sku: r.sku, wholesalePrice: r.wholesalePrice, lastSeenAt: r.lastSeenAt, latestExtractedProductId: r.latestExtractedProductId });

  it("Caso B · roundtrip: current==expectedPost → restaura exactamente a pre-run (EP histórico NO borrado)", async () => {
    const { provider, job, lease } = await seed([{ sku: "A", wholesalePrice: 100 }, { sku: "B", wholesalePrice: 50 }]);
    const pre = await snapRows(provider.id);
    await fencedPartialWrite(testPrisma, { jobId: job.id, userId: provider.userId, provider: { id: provider.id, userId: provider.userId, requiresLogin: true }, leaseVersion: lease, observations: [sp("A", 130), sp("B", 55)], priceWriteSkus: [{ sku: "A", newPrice: 130 }, { sku: "B", newPrice: 55 }], completionStats: stats(2), onLog: noLog, attemptObservedAt: ATTEMPT_OBSERVED_AT });
    const post = await snapRows(provider.id);
    const current = await snapRows(provider.id);
    const plan = buildRestorePlan({ preRun: pre.map(mutable), expectedPost: post.map(mutable), current: current.map(mutable) });
    expect(plan.safe).toBe(true);
    expect(plan.rowsWouldRestore).toBe(2);
    // aplicar el plan
    for (const e of plan.plan) await testPrisma.catalogProduct.update({ where: { id: e.id }, data: { wholesalePrice: e.to.wholesalePrice, latestExtractedProductId: e.to.latestExtractedProductId, ...(e.to.lastSeenAt ? { lastSeenAt: new Date(e.to.lastSeenAt) } : {}) } });
    expect(await priceOf(provider.id, "A")).toBe(100);
    expect(await priceOf(provider.id, "B")).toBe(50);
    expect(await epCount(job.id)).toBe(2); // ExtractedProduct histórico NO eliminado por el restore
  });

  it("Caso C · una fila cambió después (current diverge) → conflicto → fail-closed → 0 restore writes", async () => {
    const { provider, job, lease } = await seed([{ sku: "A", wholesalePrice: 100 }, { sku: "B", wholesalePrice: 50 }]);
    const pre = await snapRows(provider.id);
    await fencedPartialWrite(testPrisma, { jobId: job.id, userId: provider.userId, provider: { id: provider.id, userId: provider.userId, requiresLogin: true }, leaseVersion: lease, observations: [sp("A", 130), sp("B", 55)], priceWriteSkus: [{ sku: "A", newPrice: 130 }, { sku: "B", newPrice: 55 }], completionStats: stats(2), onLog: noLog, attemptObservedAt: ATTEMPT_OBSERVED_AT });
    const post = await snapRows(provider.id);
    // otra operación cambia B DESPUÉS de la corrida.
    const bId = post.find((r) => r.sku === "B")!.id;
    await testPrisma.catalogProduct.update({ where: { id: bId }, data: { wholesalePrice: 999 } });
    const current = await snapRows(provider.id);
    const plan = buildRestorePlan({ preRun: pre.map(mutable), expectedPost: post.map(mutable), current: current.map(mutable) });
    expect(plan.safe).toBe(false);
    expect(plan.conflictCount).toBe(1);
    // fail-closed: NO se aplica NADA. DB permanece como está (B=999, A=130).
    expect(await priceOf(provider.id, "B")).toBe(999);
    expect(await priceOf(provider.id, "A")).toBe(130);
  });
});
