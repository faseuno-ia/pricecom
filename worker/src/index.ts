/**
 * Worker independiente — polling en PostgreSQL con bloqueo atómico.
 *
 * Correr con:  npm run worker
 *
 * Para migrar a Redis/BullMQ en el futuro, ver:
 *   worker/src/queues/bullmq-queue.stub.ts
 *   worker/src/queues/job-queue.interface.ts
 */
import { PrismaClient } from "@prisma/client";
import { ScraperService } from "../../lib/scraper/scraper.service";
import { generateExcel } from "../../lib/excel/generator";
import { DbPollingQueue } from "./queues/db-polling-queue";
import type { IJobQueue } from "./queues/job-queue.interface";

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
  await prisma.extractionLog.create({ data: { jobId, level, message, metadata } });
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
          rawData:        p.rawData,
        })),
      });
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

  } catch (err) {
    const errorMsg = (err as Error).message;
    await onLog("ERROR", `✗ Job fallido: ${errorMsg}`);
    await queue.markFailed(jobId, errorMsg);
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
