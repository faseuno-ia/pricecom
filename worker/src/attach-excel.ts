// 2G-R8-Q1-R1 · Excel como ARTEFACTO DE REPORTE POST-COMMIT best-effort.
//
// Contrato CONGELADO (mejora deliberada firmada, NO restauración de la semántica pre-Q1):
//   - un fallo al generar/adjuntar el Excel NO revierte los precios ya persistidos (D-validados);
//   - NO cambia un job COMPLETED a FAILED (antes de Q1, un throw de Excel → markFailed con precios
//     ya committeados; ahora el resultado comercial no depende del artefacto de reporte).
//
// El attach está protegido por predicado (status='COMPLETED' AND excelData IS NULL) → idempotente:
//   no adjunta a un job que cambió de estado, y no pisa un Excel ya existente (retry accidental).
import type { ExtractedProduct, PrismaClient, Provider } from "@prisma/client";

/** Forma del resultado de generateExcel (lib/excel/generator ExcelResult), inyectable para test. */
export interface ExcelArtifact {
  buffer: Buffer;
  filename: string;
  fileUrl: string;
}

export type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

export interface AttachExcelDeps {
  prisma: Pick<PrismaClient, "extractedProduct" | "extractionJob">;
  generateExcel: (products: ExtractedProduct[], provider: Provider, jobId: string) => Promise<ExcelArtifact>;
  onLog: (level: LogLevel, message: string, meta?: Record<string, unknown>) => Promise<void> | void;
}

/**
 * Genera y adjunta el Excel DESPUÉS del commit comercial. NUNCA lanza: cualquier fallo queda en
 * un WARN y el job permanece COMPLETED con excelData=null (reporte reconstruible regenerando).
 *
 * @returns true sólo si adjuntó (el predicado C.bis matcheó exactamente 1 fila).
 */
export async function attachExcelPostCommit(
  deps: AttachExcelDeps,
  ctx: { jobId: string; provider: Provider },
): Promise<boolean> {
  try {
    const fullProducts = await deps.prisma.extractedProduct.findMany({ where: { jobId: ctx.jobId } });
    const excel = await deps.generateExcel(fullProducts, ctx.provider, ctx.jobId);
    // Predicado C.bis: sólo un job COMPLETED cuyo excel sigue nulo. Idempotente: no pisa un Excel
    // existente y no toca un job que cambió de estado (0 filas afectadas, sin excepción).
    const { count } = await deps.prisma.extractionJob.updateMany({
      where: { id: ctx.jobId, status: "COMPLETED", excelData: null },
      data: { excelFileUrl: excel.fileUrl, excelData: excel.buffer, excelName: excel.filename },
    });
    if (count === 1) {
      await deps.onLog("INFO", `Excel adjuntado post-commit — ${excel.filename}`);
    } else {
      await deps.onLog("WARN", "Excel no adjuntado (job no COMPLETED o ya tenía Excel) — job intacto, sin cambio de estado.");
    }
    return count === 1;
  } catch (err) {
    await deps.onLog("WARN", `Excel post-commit falló (no afecta precios ni el estado COMPLETED del job): ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}
