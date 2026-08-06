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
import { assertNoPreWritePriceRegressionForExtraction } from "../../lib/catalog/pre-write-price-guard";
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

    // 2G-R5D — BARRERA PRE-WRITE contra regresión de precios (priced→null). Corre DESPUÉS de la
    // extracción y ANTES de cualquier escritura comercial (createMany/upsert/lastExtractionAt/
    // comparison). Lee el estado existente read-only y lanza un error tipado que el catch de abajo
    // convierte en markFailed → cero escrituras comerciales. Genérica (sin lógica por providerId).
    // Sin bifurcación permisiva: corre SIEMPRE que haya productos (el userId se resuelve con la
    // misma autoridad que el upsert; la regla login-gated corre aunque falte userId).
    if (products.length > 0) {
      await assertNoPreWritePriceRegressionForExtraction(
        {
          findExisting: (userId, providerId, skus) =>
            prisma.catalogProduct.findMany({
              where: { userId, providerId, sku: { in: skus } },
              select: { id: true, sku: true, wholesalePrice: true },
            }),
          findOwnChildren: (existingIds) =>
            prisma.catalogProduct.findMany({
              where: { sourceCatalogProductId: { in: existingIds }, stockSource: "OWN" },
              select: { id: true, sourceCatalogProductId: true, wholesalePrice: true },
            }),
        },
        {
          userId: job.userId,
          providerId: provider.id,
          requiresLogin: provider.requiresLogin,
          jobId,
          products: products.map((p) => ({ sku: p.sku, wholesalePrice: p.wholesalePrice })),
          onLog,
        },
      );
    }

    // Persistir productos
    if (products.length > 0) {
      await prisma.extractedProduct.createMany({
        // Mapping extraído a una función pura (lib/scraper/extracted-product-input)
        // para poder testear la preservación de rawData sin DB. Byte-equivalente
        // al map inline previo.
        data: products.map((p) => mapScrapedToExtractedProductInput(p, jobId, provider.id)),
      });

      // Sincronizar el catálogo persistente. Aislado en try/catch porque su
      // fallo no debe abortar la extracción (Excel, comparación, etc. siguen).
      try {
        await upsertCatalogProducts(jobId, prisma);
        await onLog("DEBUG", "CatalogProduct upsert completado");
      } catch (err) {
        await onLog("WARN", "Error en upsert de CatalogProduct — no rompe la extracción", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Estadísticas
    const withPrice    = products.filter((p) => p.wholesalePrice !== null).length;
    const withoutPrice = products.length - withPrice;
    const withoutSku   = products.filter((p) => !p.sku).length;

    // Generar Excel y persistirlo en DB (no en filesystem — Railway es efímero).
    let excelFileUrl: string | null = null;
    let excelName: string | null = null;
    let excelData: Buffer | null = null;

    if (products.length > 0) {
      await onLog("INFO", "Generando archivo Excel...");
      const fullProducts = await prisma.extractedProduct.findMany({ where: { jobId } });
      const result = await generateExcel(fullProducts, provider, jobId);
      excelFileUrl = result.fileUrl;
      excelName = result.filename;
      excelData = result.buffer;
      await onLog(
        "INFO",
        `Excel generado (${(result.buffer.byteLength / 1024).toFixed(0)} KB) — ${result.filename}`
      );
    }

    // Actualizar timestamp del proveedor
    await prisma.provider.update({
      where: { id: provider.id },
      data:  { lastExtractionAt: new Date() },
    });

    await queue.markCompleted(jobId, {
      totalProducts:       products.length,
      productsWithPrice:   withPrice,
      productsWithoutPrice: withoutPrice,
      productsWithoutSku:  withoutSku,
      // excelFilePath queda null para los nuevos jobs — el Excel vive en
      // excelData (DB) y la UI lo descarga por excelFileUrl.
      excelFilePath:       null,
      excelFileUrl,
      excelData,
      excelName,
    });

    await onLog("INFO", `✓ Completado — ${products.length} productos procesados.`);

    // Comparar contra la extracción COMPLETED anterior del mismo proveedor.
    // En try/catch propio: si la comparación falla, el job ya está COMPLETED
    // y no queremos romper el worker.
    let comparisonStats: {
      newProducts: number;
      removedProducts: number;
      priceUp: number;
      priceDown: number;
      stockChanged: number;
    } | null = null;
    try {
      // Pasamos la instancia del worker para no abrir una segunda conexión.
      await compareWithPreviousExtraction(jobId, prisma);
      await onLog("INFO", "Comparación con extracción anterior generada.");
      const comp = await prisma.extractionComparison.findUnique({
        where: { jobId },
        select: {
          newProducts: true,
          removedProducts: true,
          priceUp: true,
          priceDown: true,
          stockChanged: true,
        },
      });
      comparisonStats = comp;
    } catch (err) {
      console.error("[comparison] Error al comparar:", err);
      await onLog("WARN", `No se pudo generar la comparación: ${(err as Error).message}`);
    }

    await logInfo({
      source: "EXTRACTION",
      type: "EXTRACTION_COMPLETED",
      title: `Extracción completada — ${provider.name}`,
      providerId: provider.id,
      jobId,
      metadata: {
        totalProducts: products.length,
        productsWithPrice: withPrice,
        productsWithoutPrice: withoutPrice,
        productsWithoutSku: withoutSku,
        ...(comparisonStats ?? {}),
      },
    });

  } catch (err) {
    const errorMsg = (err as Error).message;
    await onLog("ERROR", `✗ Job fallido: ${errorMsg}`);
    // G1c: markFailed es el registro AUTORITATIVO del job fallido. Para SkuFirstCompletenessError
    // lleva el mensaje bounded (reasonCode + counts + SHA + sample≤20); para cualquier error legacy
    // lleva EXACTAMENTE error.message histórico. Los diagnósticos de completitud ya no dependen solo
    // del EventLog: sobreviven en el propio registro autoritativo del job.
    const failureMessage = selectFailureMessage(err);
    // Resiliencia mutua: el fallo de markFailed no debe ocultar el error original (ya emitido por
    // onLog) ni impedir el EventLog; el fallo del EventLog no debe impedir markFailed (va primero).
    try {
      await queue.markFailed(jobId, failureMessage);
    } catch (markErr) {
      console.error(`[worker] markFailed falló para job ${jobId} (no oculta el error original):`, markErr);
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
