// Helper centralizado para escribir en el EventLog (audit trail unificado).
//
// Reglas:
//   - El logging NUNCA debe romper el flujo principal. Cualquier error al
//     escribir se loguea en consola y se sigue.
//   - Los IDs relacionados (provider/product/publication/etc) son todos
//     opcionales — se llenan los que apliquen al evento.
//   - `type` es un identificador semántico estable (ej "WOO_PRODUCT_CREATED").
//     Ver el catálogo en docs/event-log.md.
//   - `metadata` acepta cualquier JSON adicional. No incluir secretos.
//
// Uso:
//   await logInfo({ source: "SYNC", type: "WOO_SYNC_SUCCESS", title: "...", productId, ... });

import { prisma } from "@/lib/db/client";
import type { EventSeverity, EventSource } from "@prisma/client";

export interface LogEventParams {
  severity: EventSeverity;
  source: EventSource;
  type: string;
  title: string;
  description?: string;
  userId?: string;
  providerId?: string;
  productId?: string;
  publicationId?: string;
  storeId?: string;
  jobId?: string;
  metadata?: Record<string, unknown>;
}

export async function logEvent(params: LogEventParams): Promise<void> {
  try {
    await prisma.eventLog.create({
      data: {
        severity: params.severity,
        source: params.source,
        type: params.type,
        title: params.title,
        description: params.description,
        userId: params.userId,
        providerId: params.providerId,
        productId: params.productId,
        publicationId: params.publicationId,
        storeId: params.storeId,
        jobId: params.jobId,
        // Prisma's `Json` field acepta cualquier value JSON-serializable.
        // El cast a `any` evita pelearse con el tipo InputJsonValue cuando
        // metadata es Record<string, unknown>.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        metadata: (params.metadata ?? undefined) as any,
      },
    });
  } catch (err) {
    // El logging nunca debe romper el flujo principal.
    // Si la DB está caída o la fila no se puede crear, dejamos rastro en
    // consola y seguimos.
    console.error("[EventLog] Failed to write event:", err);
  }
}

export function logInfo(
  params: Omit<LogEventParams, "severity">
): Promise<void> {
  return logEvent({ ...params, severity: "INFO" });
}

export function logWarning(
  params: Omit<LogEventParams, "severity">
): Promise<void> {
  return logEvent({ ...params, severity: "WARNING" });
}

export function logError(
  params: Omit<LogEventParams, "severity">
): Promise<void> {
  return logEvent({ ...params, severity: "ERROR" });
}

export function logCritical(
  params: Omit<LogEventParams, "severity">
): Promise<void> {
  return logEvent({ ...params, severity: "CRITICAL" });
}
