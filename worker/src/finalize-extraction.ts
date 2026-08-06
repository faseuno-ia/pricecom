// 2G-R5D-R2 — Unidad REAL de orquestación de persistencia post-extracción, extraída de processJob
// para poder testear el pipeline completo con dependencias inyectables (no un helper aislado).
// Flujo idéntico al del worker:
//   scraper result → resolver userId (fail-closed) → guard pre-write → createMany → upsert →
//   excel → provider.lastExtractionAt → markCompleted → comparison → logCompleted.
// El worker construye las deps con prisma/queue/funciones reales; los tests con mocks.
import type { ScrapedProduct } from "../../lib/scraper/scraper.service";
import {
  assertNoPreWritePriceRegressionForExtraction,
  PreWriteGuardTenantError,
  type ExistingCatalogRow,
} from "../../lib/catalog/pre-write-price-guard";

export interface ComparisonStats {
  newProducts: number;
  removedProducts: number;
  priceUp: number;
  priceDown: number;
  stockChanged: number;
}
export interface FinalizeCompletedStats {
  totalProducts: number;
  productsWithPrice: number;
  productsWithoutPrice: number;
  productsWithoutSku: number;
  excelFilePath: string | null;
  excelFileUrl: string | null;
  excelData: Buffer | null;
  excelName: string | null;
}

/**
 * Resuelve el tenant autoritativo con la misma autoridad que el upsert (`job.userId`), con
 * fallback a `provider.userId` (la API de enqueue garantiza job.userId === provider.userId).
 * FAIL-CLOSED: lanza si no hay userId, o si ambos existen y difieren — ANTES de cualquier
 * escritura comercial.
 */
export function resolveEffectiveUserId(
  job: { userId?: string | null },
  provider: { userId?: string | null },
  ctx: { providerId: string; jobId: string },
): string {
  const j = job.userId ?? null;
  const p = provider.userId ?? null;
  if (j && p && j !== p) throw new PreWriteGuardTenantError("EXTRACTION_JOB_PROVIDER_USER_MISMATCH", ctx);
  const eff = j ?? p;
  if (!eff) throw new PreWriteGuardTenantError("PRE_WRITE_PRICE_GUARD_USER_ID_MISSING", ctx);
  return eff;
}

export interface FinalizeExtractionDeps {
  findExistingCatalog: (userId: string, providerId: string, skus: string[]) => Promise<ExistingCatalogRow[]>;
  createExtractedProducts: (products: ScrapedProduct[]) => Promise<void>;
  upsertCatalog: () => Promise<void>;
  generateAndAttachExcel: (products: ScrapedProduct[]) => Promise<{ fileUrl: string | null; name: string | null; data: Buffer | null }>;
  updateProviderLastExtraction: () => Promise<void>;
  markCompleted: (stats: FinalizeCompletedStats) => Promise<void>;
  runComparison: () => Promise<ComparisonStats | null>;
  logCompleted: (info: { totalProducts: number; productsWithPrice: number; productsWithoutPrice: number; productsWithoutSku: number; comparison: ComparisonStats | null }) => Promise<void>;
  onLog: (level: "DEBUG" | "INFO" | "WARN" | "ERROR", msg: string, meta?: Record<string, unknown>) => Promise<void>;
}

export interface FinalizeExtractionCtx {
  products: ScrapedProduct[];
  job: { userId?: string | null };
  provider: { id: string; requiresLogin: boolean; userId?: string | null };
  jobId: string;
}

/**
 * Persiste el resultado exitoso. Lanza (fail-closed) ANTES de cualquier escritura comercial si:
 *   - no se puede resolver un userId autoritativo (o job/provider difieren);
 *   - el guard pre-write detecta priced→null o extracción login-gated sin precios.
 * En esos casos NO se llama createMany/upsert/provider.update/markCompleted/comparison.
 */
export async function finalizeSuccessfulExtraction(
  deps: FinalizeExtractionDeps,
  ctx: FinalizeExtractionCtx,
): Promise<void> {
  const { products, job, provider, jobId } = ctx;
  // 1 · tenant fail-closed (antes de toda escritura comercial y antes de leer catálogo dependiente de tenant).
  const effectiveUserId = resolveEffectiveUserId(job, provider, { providerId: provider.id, jobId });

  if (products.length > 0) {
    // 2 · guard pre-write (priced→null / login-gated). Lanza fail-closed.
    await assertNoPreWritePriceRegressionForExtraction(
      { findExisting: deps.findExistingCatalog },
      {
        userId: effectiveUserId,
        providerId: provider.id,
        requiresLogin: provider.requiresLogin,
        jobId,
        products: products.map((p) => ({ sku: p.sku, wholesalePrice: p.wholesalePrice })),
        onLog: deps.onLog,
      },
    );
    // 3 · staging + catálogo comercial.
    await deps.createExtractedProducts(products);
    try {
      await deps.upsertCatalog();
      await deps.onLog("DEBUG", "CatalogProduct upsert completado");
    } catch (err) {
      await deps.onLog("WARN", "Error en upsert de CatalogProduct — no rompe la extracción", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const withPrice = products.filter((p) => p.wholesalePrice !== null).length;
  const withoutPrice = products.length - withPrice;
  const withoutSku = products.filter((p) => !p.sku).length;

  let excel: { fileUrl: string | null; name: string | null; data: Buffer | null } = { fileUrl: null, name: null, data: null };
  if (products.length > 0) excel = await deps.generateAndAttachExcel(products);

  await deps.updateProviderLastExtraction();
  await deps.markCompleted({
    totalProducts: products.length,
    productsWithPrice: withPrice,
    productsWithoutPrice: withoutPrice,
    productsWithoutSku: withoutSku,
    excelFilePath: null,
    excelFileUrl: excel.fileUrl,
    excelData: excel.data,
    excelName: excel.name,
  });
  await deps.onLog("INFO", `✓ Completado — ${products.length} productos procesados.`);

  const comparison = await deps.runComparison();
  await deps.logCompleted({ totalProducts: products.length, productsWithPrice: withPrice, productsWithoutPrice: withoutPrice, productsWithoutSku: withoutSku, comparison });
}

export interface JobFailureDeps {
  onLog: (level: "DEBUG" | "INFO" | "WARN" | "ERROR", msg: string, meta?: Record<string, unknown>) => Promise<void>;
  selectFailureMessage: (err: unknown) => string;
  markFailed: (jobId: string, message: string) => Promise<void>;
  sanitizeCompleteness: (err: unknown) => Record<string, unknown> | undefined;
  logError: (args: { source: string; type: string; title: string; description: string; jobId: string; metadata: Record<string, unknown> }) => Promise<void>;
}

/**
 * Handler exterior del job: mismo comportamiento que el catch de processJob. markFailed es el
 * registro autoritativo del fallo (una vez); EventLog es evidencia suplementaria. Resiliencia
 * mutua: el fallo de uno no impide el otro y nunca continúa el flujo comercial.
 */
export async function handleJobFailure(
  deps: JobFailureDeps,
  ctx: { jobId: string },
  err: unknown,
): Promise<void> {
  const errorMsg = err instanceof Error ? err.message : String(err);
  await deps.onLog("ERROR", `✗ Job fallido: ${errorMsg}`);
  const failureMessage = deps.selectFailureMessage(err);
  try {
    await deps.markFailed(ctx.jobId, failureMessage);
  } catch (markErr) {
    console.error(`[worker] markFailed falló para job ${ctx.jobId} (no oculta el error original):`, markErr);
  }
  const skuFirstCompleteness = deps.sanitizeCompleteness(err);
  try {
    await deps.logError({
      source: "EXTRACTION",
      type: "EXTRACTION_FAILED",
      title: "Extracción fallida",
      description: errorMsg,
      jobId: ctx.jobId,
      metadata: skuFirstCompleteness ? { error: errorMsg, skuFirstCompleteness } : { error: errorMsg },
    });
  } catch (logErr) {
    console.error(`[worker] logError falló para job ${ctx.jobId} (markFailed ya intentado):`, logErr);
  }
}
