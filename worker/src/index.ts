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
import { finalizeSuccessfulExtraction, handleJobFailure } from "./finalize-extraction";
import { DbPollingQueue } from "./queues/db-polling-queue";
import type { IJobQueue } from "./queues/job-queue.interface";
import { logInfo, logError } from "../../lib/events/event-log";
import { runConsistencyCheck } from "./consistency-check";

// ─── Configuración ────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS   = parseInt(process.env.WORKER_POLL_INTERVAL   ?? "5000");
const STALE_JOB_TIMEOUT  = parseInt(process.env.WORKER_STALE_TIMEOUT_MS ?? String(10 * 60 * 1000));
const STALE_CHECK_EVERY  = 12; // cada 12 polls (~1 min) revisar stale jobs
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
async function processJob(jobId: string) {
  console.log(`\n► Procesando job ${jobId} (PID ${process.pid})`);

  const job = await prisma.extractionJob.findUnique({
    where: { id: jobId },
    include: { provider: { include: { scraperConfig: true } } },
  });

  if (!job?.provider) {
    console.error(`Job ${jobId}: proveedor no encontrado, saltando.`);
    await queue.markFailed(jobId, "Proveedor no encontrado");
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

    // 2G-R5D-R2 — Persistencia post-extracción extraída a `finalizeSuccessfulExtraction` (unidad
    // real testeable con deps inyectables). Resuelve el userId FAIL-CLOSED, corre el guard pre-write
    // (priced→null / login-gated) ANTES de cualquier escritura comercial, y sólo entonces persiste.
    // Si el userId falta/difiere o el guard detecta regresión, LANZA → el catch de abajo hace
    // markFailed → cero escrituras comerciales.
    await finalizeSuccessfulExtraction(
      {
        findExistingCatalog: (userId, providerId, skus) =>
          prisma.catalogProduct.findMany({
            where: { userId, providerId, sku: { in: skus } },
            select: { id: true, sku: true, wholesalePrice: true },
          }),
        createExtractedProducts: async (prods) => {
          await prisma.extractedProduct.createMany({
            data: prods.map((p) => mapScrapedToExtractedProductInput(p, jobId, provider.id)),
          });
        },
        upsertCatalog: () => upsertCatalogProducts(jobId, prisma),
        generateAndAttachExcel: async () => {
          await onLog("INFO", "Generando archivo Excel...");
          const fullProducts = await prisma.extractedProduct.findMany({ where: { jobId } });
          const result = await generateExcel(fullProducts, provider, jobId);
          await onLog("INFO", `Excel generado (${(result.buffer.byteLength / 1024).toFixed(0)} KB) — ${result.filename}`);
          return { fileUrl: result.fileUrl, name: result.filename, data: result.buffer };
        },
        updateProviderLastExtraction: async () => {
          await prisma.provider.update({ where: { id: provider.id }, data: { lastExtractionAt: new Date() } });
        },
        markCompleted: (stats) => queue.markCompleted(jobId, stats),
        runComparison: async () => {
          try {
            await compareWithPreviousExtraction(jobId, prisma);
            await onLog("INFO", "Comparación con extracción anterior generada.");
            return await prisma.extractionComparison.findUnique({
              where: { jobId },
              select: { newProducts: true, removedProducts: true, priceUp: true, priceDown: true, stockChanged: true },
            });
          } catch (err) {
            console.error("[comparison] Error al comparar:", err);
            await onLog("WARN", `No se pudo generar la comparación: ${(err as Error).message}`);
            return null;
          }
        },
        logCompleted: (info) =>
          logInfo({
            source: "EXTRACTION",
            type: "EXTRACTION_COMPLETED",
            title: `Extracción completada — ${provider.name}`,
            providerId: provider.id,
            jobId,
            metadata: {
              totalProducts: info.totalProducts,
              productsWithPrice: info.productsWithPrice,
              productsWithoutPrice: info.productsWithoutPrice,
              productsWithoutSku: info.productsWithoutSku,
              ...(info.comparison ?? {}),
            },
          }),
        onLog,
      },
      { products, job, provider, jobId },
    );

  } catch (err) {
    // 2G-R5D-R2 — handler exterior extraído: markFailed (autoritativo, 1×) + EventLog suplementario.
    // Incluye errores del guard pre-write / tenant (fail-closed) y de la extracción (completitud, etc.).
    await handleJobFailure(
      {
        onLog,
        selectFailureMessage,
        markFailed: (jid, msg) => queue.markFailed(jid, msg),
        sanitizeCompleteness: (e) =>
          e instanceof SkuFirstCompletenessError ? sanitizeSkuFirstCompletenessDiagnostics(e) : undefined,
        logError: (args) => logError(args as Parameters<typeof logError>[0]),
      },
      { jobId },
      err,
    );
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
        await processJob(payload.jobId);
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
