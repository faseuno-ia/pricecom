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
import { ScraperService } from "../../lib/scraper/scraper.service";
import { generateExcel } from "../../lib/excel/generator";
import { compareWithPreviousExtraction } from "../../lib/comparison/compare-extractions";
import { upsertCatalogProducts } from "../../lib/catalog/upsert-catalog-products";
import { DbPollingQueue } from "./queues/db-polling-queue";
import type { IJobQueue } from "./queues/job-queue.interface";
import { logInfo, logError } from "../../lib/events/event-log";

// ─── Configuración ────────────────────────────────────────────────────────────
const POLL_INTERVAL_MS   = parseInt(process.env.WORKER_POLL_INTERVAL   ?? "5000");
const STALE_JOB_TIMEOUT  = parseInt(process.env.WORKER_STALE_TIMEOUT_MS ?? String(10 * 60 * 1000));
const STALE_CHECK_EVERY  = 12; // cada 12 polls (~1 min) revisar stale jobs

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

  const scraper = new ScraperService();

  try {
    const products = await scraper.run({
      provider,
      config: provider.scraperConfig,
      startUrl: job.startUrl,
      onLog,
      onProgress,
    });

    // Persistir productos
    if (products.length > 0) {
      await prisma.extractedProduct.createMany({
        data: products.map((p) => ({
          jobId,
          providerId: provider.id,
          sku:            p.sku,
          name:           p.name || "Sin nombre",
          description:    p.description,
          wholesalePrice: p.wholesalePrice,
          oldPrice:       p.oldPrice,
          stock:          p.stock,
          category:       p.category,
          brand:          p.brand,
          productUrl:     p.productUrl,
          imageUrl:       p.imageUrl,
          // rawData del scraper es Record<string, unknown> por API genérica.
          // Cast al InputJsonValue de Prisma para el boundary de persistencia.
          rawData:        p.rawData as Prisma.InputJsonValue,
        })),
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

    // Generar Excel
    let excelFilePath: string | null = null;
    let excelFileUrl:  string | null = null;

    if (products.length > 0) {
      await onLog("INFO", "Generando archivo Excel...");
      const fullProducts = await prisma.extractedProduct.findMany({ where: { jobId } });
      const result = await generateExcel(fullProducts, provider, jobId);
      excelFilePath = result.filePath;
      excelFileUrl  = result.fileUrl;
      await onLog("INFO", `Excel guardado en: ${excelFilePath}`);
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
      excelFilePath,
      excelFileUrl,
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
    await queue.markFailed(jobId, errorMsg);
    await logError({
      source: "EXTRACTION",
      type: "EXTRACTION_FAILED",
      title: "Extracción fallida",
      description: errorMsg,
      jobId,
      metadata: { error: errorMsg },
    });
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
