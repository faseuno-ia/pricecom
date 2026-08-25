// 2G-R8-Q2.1-B · §7/§9 — Transacción FENCED de partial-commit, EXTRAÍDA para ser testeable en
// PostgreSQL real (atomicidad W15-W20). Semántica Q1-R1 preservada + reglas Q2.1-B:
//   BEGIN
//     1 · CAS de ownership (0 filas → LeaseFencingError → rollback total)
//     2 · D SÓLO sobre el PRICE_WRITE_SET (§9.1); si el write-set está vacío D NO se invoca (§6)
//     3 · createMany ExtractedProduct = OBSERVACIONES (política OBSERVATIONS, §addendum A)
//     4 · PRICE_ONLY writes SÓLO del write-set explícito (writePriceOnlyExplicit; lista en memoria)
//     5 · Provider update
//     6 · terminal COMPLETED (excel null)
//   COMMIT
// Cualquier throw dentro de la tx → rollback total (Prisma $transaction). Los `faults` son seams
// SÓLO para tests de atomicidad; producción los omite.

import type { PrismaClient } from "@prisma/client";
import type { ScrapedProduct } from "../../lib/scraper/scraper.service";
import { mapScrapedToExtractedProductInput } from "../../lib/scraper/extracted-product-input";
import { assertNoPreWritePriceRegressionForExtraction } from "../../lib/catalog/pre-write-price-guard";
import { writePriceOnlyExplicit } from "../../lib/catalog/price-only-partial-write";
import { LeaseFencingError } from "./lease-fencing-error";

export interface FencedPartialWriteParams {
  jobId: string;
  userId: string | null;
  provider: { id: string; userId: string | null; requiresLogin: boolean };
  /** valor esperado de workerLockedAt (el lease del worker). El CAS falla si no coincide. */
  leaseVersion: Date;
  observations: ScrapedProduct[];
  /** C2-MINI-A · UN instante de observación por attempt, compartido por todo el snapshot. */
  attemptObservedAt: Date;
  priceWriteSkus: Array<{ sku: string; newPrice: number }>;
  completionStats: Record<string, number>;
  onLog: (level: "DEBUG" | "INFO" | "WARN" | "ERROR", msg: string) => Promise<void> | void;
  /** Seam de inyección de falla JS a mitad del loop de updates — SÓLO tests (W17_JS). W18/W19 usan
   *  fallas REALES de tx.provider.update() / terminal via triggers de Postgres. */
  faults?: { throwAfterPriceUpdates?: number };
}

export interface FencedPartialWriteResult { committed: boolean; finalizationMs: number; writtenCount: number }

export async function fencedPartialWrite(prisma: PrismaClient, params: FencedPartialWriteParams): Promise<FencedPartialWriteResult> {
  const { jobId, provider, leaseVersion, observations, priceWriteSkus, completionStats, faults } = params;
  const t0 = Date.now();
  let writtenCount = 0;
  await prisma.$transaction(async (tx) => {
    // 1 · CAS de ownership.
    const owned = await tx.$queryRaw<{ id: string }[]>`
      UPDATE "ExtractionJob" SET "workerLockedAt" = NOW(), "updatedAt" = NOW()
      WHERE id = ${jobId} AND status = 'RUNNING' AND "workerLockedAt" = ${leaseVersion}
      RETURNING id`;
    if (owned.length !== 1) throw new LeaseFencingError();

    // 2 · D SÓLO sobre el write-set. Vacío → NOT_APPLICABLE (§6): no se invoca.
    if (priceWriteSkus.length > 0) {
      await assertNoPreWritePriceRegressionForExtraction(
        { findExisting: (u, pr, s) => tx.catalogProduct.findMany({ where: { userId: u, providerId: pr, sku: { in: s } }, select: { id: true, sku: true, wholesalePrice: true } }) },
        { userId: params.userId, providerUserId: provider.userId, providerId: provider.id, requiresLogin: provider.requiresLogin, jobId, products: priceWriteSkus.map((w) => ({ sku: w.sku, wholesalePrice: w.newPrice })), onLog: params.onLog },
      );
    }

    // 3 · ExtractedProduct = OBSERVACIONES.
    await tx.extractedProduct.createMany({ data: observations.map((prod) => mapScrapedToExtractedProductInput(prod, jobId, provider.id, params.attemptObservedAt)) });
    const eps = await tx.extractedProduct.findMany({ where: { jobId }, select: { id: true, sku: true } });
    const epBySku = new Map(eps.map((e) => [String(e.sku ?? "").trim(), e.id]));

    // 4 · PRICE_ONLY writes SÓLO del write-set explícito.
    const entries = priceWriteSkus
      .map((w) => ({ sku: w.sku, newPrice: w.newPrice, extractedProductId: epBySku.get(w.sku) }))
      .filter((e): e is { sku: string; newPrice: number; extractedProductId: string } => typeof e.extractedProductId === "string");
    const wr = await writePriceOnlyExplicit(
      { catalogProduct: { findMany: (a) => tx.catalogProduct.findMany(a) as never, update: (a) => tx.catalogProduct.update(a) as never } },
      {
        userId: params.userId as string, providerId: provider.id, entries, lastSeenAt: new Date(),
        onAfterEachUpdate: faults?.throwAfterPriceUpdates != null
          ? (n) => { if (n >= (faults.throwAfterPriceUpdates as number)) throw new Error(`__TEST_FAULT_JS_AFTER_${n}_UPDATES`); }
          : undefined,
      },
    );
    writtenCount = wr.written;

    // 5 · Provider update.
    await tx.provider.update({ where: { id: provider.id }, data: { lastExtractionAt: new Date() } });

    // 6 · terminal COMPLETED (excel null; post-commit best-effort).
    await tx.extractionJob.updateMany({
      where: { id: jobId },
      data: { status: "COMPLETED", finishedAt: new Date(), progress: 100, ...completionStats, excelFilePath: null, excelFileUrl: null, excelData: null, excelName: null, workerLockedAt: null, updatedAt: new Date() },
    });
  }, { timeout: 120000, maxWait: 15000 });
  return { committed: true, finalizationMs: Date.now() - t0, writtenCount };
}
