/**
 * Worker independiente — polling en PostgreSQL con bloqueo atómico.
 *
 * Correr con:  npm run worker
 *
 * Para migrar a Redis/BullMQ en el futuro, ver:
 *   worker/src/queues/bullmq-queue.stub.ts
 *   worker/src/queues/job-queue.interface.ts
 */
import { PrismaClient, Prisma } from "@prisma/client";
import {
  ScraperService,
  DIFFERENTTOUCH_SITEMAP_MIN_EXPECTED_PRODUCTS,
  SkuFirstCompletenessError,
  sanitizeSkuFirstCompletenessDiagnostics,
  type ScrapedProduct,
} from "../../lib/scraper/scraper.service";
import { selectFailureMessage } from "../../lib/scraper/sku-first-start";
import { mapScrapedToExtractedProductInput } from "../../lib/scraper/extracted-product-input";
import { buildProviderRuntimeConfig } from "../../lib/scraper/provider-runtime-config";
import { extractWooStoreApi } from "../../lib/extractors/woo-store-api-extractor";
import { generateExcel } from "../../lib/excel/generator";
import { compareWithPreviousExtraction } from "../../lib/comparison/compare-extractions";
import { upsertCatalogProducts } from "../../lib/catalog/upsert-catalog-products";
import { attachExcelPostCommit } from "./attach-excel";
import { assertNoPreWritePriceRegressionForExtraction } from "../../lib/catalog/pre-write-price-guard";
import { DbPollingQueue } from "./queues/db-polling-queue";
import type { IJobQueue, JobPayload } from "./queues/job-queue.interface";
import { JobLease } from "./job-lease";
import { resolveCatalogWriteMode } from "../../lib/catalog/catalog-write-mode";
import { logInfo, logError } from "../../lib/events/event-log";
import { runConsistencyCheck } from "./consistency-check";

/** 2G-R8-Q1 · señal interna: el CAS de ownership dentro de la tx fenced afectó 0 filas (lease
 * perdido) → hace rollback de toda la transacción comercial. No es un fallo del job. */
class LeaseFencingError extends Error {
  constructor() { super("LEASE_FENCING_LOST"); this.name = "LeaseFencingError"; }
}

// ─── Configuración ────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS   = parseInt(process.env.WORKER_POLL_INTERVAL   ?? "5000");
const STALE_JOB_TIMEOUT  = parseInt(process.env.WORKER_STALE_TIMEOUT_MS ?? String(10 * 60 * 1000));
const STALE_CHECK_EVERY  = 12; // cada 12 polls (~1 min) revisar stale jobs
// 2G-R8-Q1 · heartbeat de lease. 60s de intervalo → ~10 renovaciones dentro del stale timeout de
// 600s → un job vivo (walk largo) nunca se re-clama. Seguridad operativa, no inferencia de duración.
const WORKER_LEASE_HEARTBEAT_INTERVAL_MS = parseInt(process.env.WORKER_LEASE_HEARTBEAT_INTERVAL_MS ?? "60000");
// Cada 60 polls (~5 min a 5s/poll) chequea consistencia. Con módulo 1 se
// dispara también en el primer ciclo, para limpiar lo que quedó de períodos
// donde el worker estuvo caído.
const CONSISTENCY_CHECK_EVERY = 60;

// ─── Instancias ───────────────────────────────────────────────────────────────
const prisma = new PrismaClient();

/**
 * PUNTO DE SWAP: cambiar DbPollingQueue por BullMqQueue para migrar a Redis.
 * Todo el código de abajo depende de IJobQueue, no de la implementación concreta.
 */
const queue: IJobQueue = new DbPollingQueue(prisma);

// ─── Helpers ──────────────────────────────────────────────────────────────────
async function writeLog(
  jobId: string,
  level: "DEBUG" | "INFO" | "WARN" | "ERROR",
  message: string,
  metadata?: Record<string, unknown>
) {
  // Cast al tipo JSON estricto de Prisma en el boundary de serialización.
  // El scraper produce metadata genérica (Record<string, unknown>) por flexibilidad
  // de logging; Prisma exige InputJsonValue (objeto JSON-serializable).
  await prisma.extractionLog.create({
    data: {
      jobId,
      level,
      message,
      metadata: metadata as Prisma.InputJsonValue | undefined,
    },
  });
  console.log(`[${level}][${new Date().toISOString()}] ${message}`, metadata ?? "");
}

// ─── Procesador de job ────────────────────────────────────────────────────────
async function processJob(payload: JobPayload) {
  const { jobId, leaseVersion } = payload;
  console.log(`\n► Procesando job ${jobId} (PID ${process.pid})`);

  // 2G-R8-Q1 · lease heartbeat: renueva el ownership (workerLockedAt) mientras el job trabaja, de
  // modo que releaseStaleJobs (10 min) NUNCA re-clame un walk vivo (causa raíz de la doble ejecución
  // del canary R8-P0). Si el lease se pierde/queda desconocido, la finalización NO persiste.
  const lease = new JobLease(jobId, leaseVersion, queue, WORKER_LEASE_HEARTBEAT_INTERVAL_MS, (l, m) => {
    void writeLog(jobId, l, m).catch(() => {});
  });
  lease.start();

  try {
  const job = await prisma.extractionJob.findUnique({
    where: { id: jobId },
    include: { provider: { include: { scraperConfig: true } } },
  });

  if (!job?.provider) {
    console.error(`Job ${jobId}: proveedor no encontrado, saltando.`);
    const fin = await lease.pauseForFinalization();
    if (fin.owned) await queue.markFailed(jobId, "Proveedor no encontrado", fin.leaseVersion);
    return;
  }

  const { provider } = job;
  const maxPages = provider.scraperConfig?.maxPages ?? 10;

  const onLog = (
    level: "DEBUG" | "INFO" | "WARN" | "ERROR",
    message: string,
    meta?: Record<string, unknown>
  ) => writeLog(jobId, level, message, meta);

  /**
   * onProgress recibe (paginaActual, pagesMax, productosParciales).
   * Calcula % de progreso basado en páginas recorridas vs límite configurado.
   */
  const onProgress = async (currentPage: number, totalFoundSoFar: number) => {
    const progress = Math.min(Math.round((currentPage / maxPages) * 100), 99);
    await queue.updateProgress(jobId, progress, totalFoundSoFar);
  };

  try {
    let products: ScrapedProduct[];

    if (provider.providerType === "WOO_STORE_API") {
      // Camino Store API (JSON). No usa Playwright ni scraperConfig.
      // El progreso se basa en el total REAL de páginas (X-WP-TotalPages),
      // no en maxPages (que es config de scraping HTML y no aplica acá).
      const onProgressApi = async (
        currentPage: number,
        totalPages: number,
        totalFound: number
      ) => {
        const progress = Math.min(
          Math.round((currentPage / Math.max(totalPages, 1)) * 100),
          99
        );
        await queue.updateProgress(jobId, progress, totalFound);
      };

      products = await extractWooStoreApi({
        baseUrl: provider.baseUrl,
        skuPrefix: provider.skuPrefix,
        fetchFn: (url) => fetch(url),
        onProgress: onProgressApi,
        onLog,
      });
    } else {
      // Camino scraper HTML. La config efectiva se construye desde el scraperConfig de Prisma
      // con el builder puro. G1: effectiveExtractionMode → ScraperOptions.extractionMode;
      // effectiveLoginUrl → performLogin legacy (navega a la loginUrl validada antes del form).
      // loginFlowStrategy sigue SIN conectarse al ejecutor DOCUMENT_REDIRECT (permanece LEGACY;
      // A3_LOGIN_EXECUTOR_CONFIG_DRIVEN = false).
      const runtimeConfig = buildProviderRuntimeConfig({
        provider: { baseUrl: provider.baseUrl },
        scraperConfig: provider.scraperConfig,
      });
      const scraper = new ScraperService();
      products = await scraper.run({
        provider,
        config: provider.scraperConfig,
        startUrl: job.startUrl,
        onLog,
        onProgress,
        extractionMode:
          runtimeConfig.effectiveExtractionMode === "TIENDANUBE_LS_VARIANTS_SKU_FIRST"
            ? "TIENDANUBE_LS_VARIANTS_SKU_FIRST"
            : undefined,
        effectiveLoginUrl: runtimeConfig.effectiveLoginUrl,
        // G1: referencia pública de sitemap para el gate de completitud fail-closed (solo se usa
        // en SKU-first; en legacy no se invoca). Adapta `fetch` global al contrato HttpResponseLike.
        sitemapFetchFn: async (url) => {
          // GUARD_1: redirect "manual" → un 3xx vuelve como respuesta 3xx (sin seguir Location,
          // sin segunda request). La validación de host/estado la hace runtime-sitemap-reference.
          const res = await fetch(url, { redirect: "manual" });
          return {
            status: res.status,
            text: await res.text(),
            finalUrl: res.url,
            header: (n: string) => res.headers.get(n),
          };
        },
        sitemapMinExpectedProducts: DIFFERENTTOUCH_SITEMAP_MIN_EXPECTED_PRODUCTS,
      });
    }

    // 2G-R8-Q1 · Finalización LEASE-FENCED. Handoff (5.bis): detener el heartbeat y esperar cualquier
    // renovación en vuelo ANTES de finalizar (evita que el heartbeat se robe el lease a sí mismo).
    const fin = await lease.pauseForFinalization();
    if (!fin.owned) {
      await onLog("WARN", `[WorkerLease] ownership ${fin.state} antes de finalizar — se ABORTA la persistencia sin escritura comercial ni terminal; el job queda RUNNING para stale recovery.`);
      return;
    }

    const withPrice    = products.filter((p) => p.wholesalePrice !== null).length;
    const withoutPrice = products.length - withPrice;
    const withoutSku   = products.filter((p) => !p.sku).length;
    const writeMode = resolveCatalogWriteMode(provider.scraperConfig?.catalogWriteMode);
    const completionStats = { totalProducts: products.length, productsWithPrice: withPrice, productsWithoutPrice: withoutPrice, productsWithoutSku: withoutSku };

    // Comparación + EventLog de completado (best-effort, post-terminal; no comercial).
    const emitCompletion = async () => {
      let comparisonStats: { newProducts: number; removedProducts: number; priceUp: number; priceDown: number; stockChanged: number } | null = null;
      try {
        await compareWithPreviousExtraction(jobId, prisma);
        await onLog("INFO", "Comparación con extracción anterior generada.");
        comparisonStats = await prisma.extractionComparison.findUnique({ where: { jobId }, select: { newProducts: true, removedProducts: true, priceUp: true, priceDown: true, stockChanged: true } });
      } catch (err) {
        console.error("[comparison] Error al comparar:", err);
        await onLog("WARN", `No se pudo generar la comparación: ${(err as Error).message}`);
      }
      await logInfo({ source: "EXTRACTION", type: "EXTRACTION_COMPLETED", title: `Extracción completada — ${provider.name}`, providerId: provider.id, jobId, metadata: { ...completionStats, ...(comparisonStats ?? {}) } });
    };

    // ── PRICE_ONLY: escritura comercial FENCED END-TO-END en UNA transacción (sin EventLog/Woo ⇒
    //    tx-scopable, 6.quater/6.quinquies). CAS de ownership como PRIMERA sentencia; si falla → throw
    //    → rollback TOTAL (cero writes comerciales; el old owner no puede commitear). ──
    if (products.length > 0 && writeMode === "PRICE_ONLY") {
      let finalized = false;
      try {
        await prisma.$transaction(async (tx) => {
          const owned = await tx.$queryRaw<{ id: string }[]>`
            UPDATE "ExtractionJob" SET "workerLockedAt" = NOW(), "updatedAt" = NOW()
            WHERE id = ${jobId} AND status = 'RUNNING' AND "workerLockedAt" = ${fin.leaseVersion}
            RETURNING id`;
          if (owned.length !== 1) throw new LeaseFencingError();
          await assertNoPreWritePriceRegressionForExtraction(
            { findExisting: (u, p, s) => tx.catalogProduct.findMany({ where: { userId: u, providerId: p, sku: { in: s } }, select: { id: true, sku: true, wholesalePrice: true } }) },
            { userId: job.userId, providerUserId: provider.userId, providerId: provider.id, requiresLogin: provider.requiresLogin, jobId, products: products.map((p) => ({ sku: p.sku, wholesalePrice: p.wholesalePrice })), onLog },
          );
          await tx.extractedProduct.createMany({ data: products.map((p) => mapScrapedToExtractedProductInput(p, jobId, provider.id)) });
          await upsertCatalogProducts(jobId, tx as unknown as PrismaClient);
          await tx.provider.update({ where: { id: provider.id }, data: { lastExtractionAt: new Date() } });
          // Terminal COMPLETED con Excel NULO: el artefacto de reporte se genera POST-COMMIT
          // (best-effort). Su generación NO debe poder revertir precios ya validados por D.
          await tx.extractionJob.updateMany({
            where: { id: jobId },
            data: { status: "COMPLETED", finishedAt: new Date(), progress: 100, ...completionStats, excelFilePath: null, excelFileUrl: null, excelData: null, excelName: null, workerLockedAt: null, updatedAt: new Date() },
          });
          finalized = true;
        }, { timeout: 120000, maxWait: 15000 });
      } catch (txErr) {
        if (txErr instanceof LeaseFencingError) {
          await onLog("WARN", `[WorkerLease] lease perdido durante la finalización fenced — rollback total, cero writes comerciales; el job queda RUNNING.`);
          return;
        }
        throw txErr; // D u otros errores → catch histórico → fenced markFailed
      }
      if (!finalized) return;
      await onLog("INFO", `✓ Completado (PRICE_ONLY fenced) — ${products.length} productos procesados.`);
      // POST-COMMIT: Excel = artefacto de reporte best-effort. Ya NO hay lease (workerLockedAt=NULL,
      // job COMPLETED). attachExcelPostCommit NUNCA lanza: un fallo deja el job COMPLETED con
      // excelData=null (regenerable) — no revierte precios ni cambia el estado del job.
      await attachExcelPostCommit({ prisma, generateExcel, onLog }, { jobId, provider });
      await emitCompletion();
      return;
    }

    // ── FULL (u otros modes/providers): flujo histórico inline; terminal COMPLETED FENCED por CAS.
    //    FULL puede llamar Woo/EventLog no-transaccionales → NO se envuelve en una tx DB (garantía por
    //    partes, 6.quinquies): terminal fencing genérico, pero los writes comerciales no son atómicos. ──
    if (products.length > 0) {
      await assertNoPreWritePriceRegressionForExtraction(
        { findExisting: (userId, providerId, skus) => prisma.catalogProduct.findMany({ where: { userId, providerId, sku: { in: skus } }, select: { id: true, sku: true, wholesalePrice: true } }) },
        { userId: job.userId, providerUserId: provider.userId, providerId: provider.id, requiresLogin: provider.requiresLogin, jobId, products: products.map((p) => ({ sku: p.sku, wholesalePrice: p.wholesalePrice })), onLog },
      );
      await prisma.extractedProduct.createMany({ data: products.map((p) => mapScrapedToExtractedProductInput(p, jobId, provider.id)) });
      try {
        await upsertCatalogProducts(jobId, prisma);
        await onLog("DEBUG", "CatalogProduct upsert completado");
      } catch (err) {
        await onLog("WARN", "Error en upsert de CatalogProduct — no rompe la extracción", { error: err instanceof Error ? err.message : String(err) });
      }
    }

    let excelFileUrl: string | null = null;
    let excelName: string | null = null;
    let excelData: Buffer | null = null;
    if (products.length > 0) {
      await onLog("INFO", "Generando archivo Excel...");
      const fullProducts = await prisma.extractedProduct.findMany({ where: { jobId } });
      const result = await generateExcel(fullProducts, provider, jobId);
      excelFileUrl = result.fileUrl; excelName = result.filename; excelData = result.buffer;
      await onLog("INFO", `Excel generado (${(result.buffer.byteLength / 1024).toFixed(0)} KB) — ${result.filename}`);
    }
    await prisma.provider.update({ where: { id: provider.id }, data: { lastExtractionAt: new Date() } });

    const finalizedFull = await queue.markCompleted(jobId, { ...completionStats, excelFilePath: null, excelFileUrl, excelData, excelName }, fin.leaseVersion);
    if (!finalizedFull) {
      await onLog("WARN", `[WorkerLease] terminal COMPLETED suprimido (ownership ya no es nuestro).`);
      return;
    }
    await onLog("INFO", `✓ Completado — ${products.length} productos procesados.`);
    await emitCompletion();

  } catch (err) {
    const errorMsg = (err as Error).message;
    await onLog("ERROR", `✗ Job fallido: ${errorMsg}`);
    // G1c: markFailed es el registro AUTORITATIVO del job fallido. Para SkuFirstCompletenessError
    // lleva el mensaje bounded (reasonCode + counts + SHA + sample≤20); para cualquier error legacy
    // lleva EXACTAMENTE error.message histórico. Los diagnósticos de completitud ya no dependen solo
    // del EventLog: sobreviven en el propio registro autoritativo del job.
    const failureMessage = selectFailureMessage(err);
    // 2G-R8-Q1 · markFailed FENCED: sólo si seguimos siendo dueños. Si el lease se perdió (reclaim) o
    // quedó UNKNOWN (DB error), NO escribimos estado terminal — hacerlo sobre la ejecución nueva es
    // exactamente el daño que Q1 previene (5.ter). El job queda RUNNING y stale recovery lo maneja.
    const finFail = await lease.pauseForFinalization();
    if (finFail.owned) {
      try {
        const marked = await queue.markFailed(jobId, failureMessage, finFail.leaseVersion);
        if (!marked) await onLog("WARN", `[WorkerLease] markFailed suprimido (ownership ya no es nuestro).`);
      } catch (markErr) {
        console.error(`[worker] markFailed falló para job ${jobId} (no oculta el error original):`, markErr);
      }
    } else {
      await onLog("WARN", `[WorkerLease] error del job con lease ${finFail.state} — NO se marca FAILED (job queda RUNNING para stale recovery).`);
    }
    // EventLog = evidencia SUPLEMENTARIA (no única copia). reasonCode + counts + sample≤20 + SHA;
    // nunca listas completas/precios/HTML/cookies/tokens.
    const skuFirstCompleteness =
      err instanceof SkuFirstCompletenessError ? sanitizeSkuFirstCompletenessDiagnostics(err) : undefined;
    try {
      await logError({
        source: "EXTRACTION",
        type: "EXTRACTION_FAILED",
        title: "Extracción fallida",
        description: errorMsg,
        jobId,
        metadata: skuFirstCompleteness ? { error: errorMsg, skuFirstCompleteness } : { error: errorMsg },
      });
    } catch (logErr) {
      console.error(`[worker] logError falló para job ${jobId} (markFailed ya intentado):`, logErr);
    }
  }
  } finally {
    // 2G-R8-Q1 · siempre detener el heartbeat (limpieza del timer; sin dangling interval).
    await lease.stop("processJob-end");
  }
}

// ─── Poll loop ────────────────────────────────────────────────────────────────
async function pollLoop() {
  console.log(`
⚙  Worker iniciado
   PID:            ${process.pid}
   Poll interval:  ${POLL_INTERVAL_MS}ms
   Stale timeout:  ${STALE_JOB_TIMEOUT / 1000}s
   Cola:           DbPollingQueue (PostgreSQL + FOR UPDATE SKIP LOCKED)
`);

  let pollCount = 0;

  while (true) {
    try {
      pollCount++;

      // Liberar stale jobs periódicamente (workers muertos sin completar)
      if (pollCount % STALE_CHECK_EVERY === 0) {
        const released = await queue.releaseStaleJobs(STALE_JOB_TIMEOUT);
        if (released > 0) {
          console.log(`[INFO] Se liberaron ${released} job(s) stale → vuelven a PENDING`);
        }
      }

      // Job de consistencia: arregla combinaciones inválidas entre
      // ProductPublication y CatalogProduct (DRAFT residuales, ACTIVE con
      // proveedor removido, ACTIVE con producto pausado). El % 60 === 1
      // dispara en el ciclo 1, 61, 121... = arranque + cada 60 polls.
      if (pollCount % CONSISTENCY_CHECK_EVERY === 1) {
        try {
          await runConsistencyCheck(prisma);
        } catch (err) {
          // runConsistencyCheck ya tiene try/catch por caso, pero defensa
          // en profundidad: si algo dispara antes de los try internos, no
          // queremos matar el worker.
          console.error("[ERROR] Consistency check falló:", err);
        }
      }

      // Tomar el siguiente job disponible de forma atómica
      const payload = await queue.claimNextJob();

      if (payload) {
        await processJob(payload);
      }

    } catch (err) {
      console.error("[ERROR] Error en poll loop:", err);
    }

    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
}

// ─── Graceful shutdown ────────────────────────────────────────────────────────
process.on("SIGINT",  shutdown);
process.on("SIGTERM", shutdown);

async function shutdown() {
  console.log("\n🛑 Cerrando worker...");
  await prisma.$disconnect();
  process.exit(0);
}

pollLoop();
