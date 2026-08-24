// NEON-GATE2A-EXEC-2 · T2 · consistencia al END_OF_ATTEMPT.
//
// T2 = END_OF_ATTEMPT, no END_OF_SUCCESS.
//
// El path HISTORICAL/FULL NO es transaccional: `createMany` y `upsertCatalogProducts` corren fuera
// de transacción (worker/src/index.ts:298-310) y el terminal llega después (:322-324). El
// PRODUCT_AUTO_PAUSED que produce el material de case2 se emite DURANTE el upsert
// (lib/catalog/upsert-catalog-products.ts:513). Un job que muere después de marcar
// SUPPLIER_REMOVED y antes de terminalizar deja material commiteado: atarlo a `success` dejaría
// sin cobertura justamente el caso más probable.
//
// ALCANCE: sólo case2, sólo el providerId del job, sólo paths capaces de producirlo.
// T1, T3 y T4 son de 2B.
//
// POST-COMMIT OBLIGATORIO: la reparación llama a Woo por HTTP
// (publication-service.ts:589). Una llamada remota dentro de una transacción la mantiene abierta
// mientras dura el HTTP y no es rollback-able. T2 corre después del terminal, nunca dentro de una tx.

import type { PrismaClient } from "@prisma/client";
import { WooCommerceClient } from "../../lib/integrations/woocommerce/client";
import { pauseProductInWoo } from "../../lib/integrations/woocommerce/publication-service";
import { logWarning, logError } from "../../lib/events/event-log";

export interface EndOfAttemptSignals {
  /** ¿Este attempt corrió el upsert FULL/HISTORICAL, capaz de marcar SUPPLIER_REMOVED? */
  fullUpsertAttempted: boolean;
  /** Se registra por claridad del contrato: NO condiciona la decisión. */
  succeeded: boolean;
}

/**
 * Sólo los paths capaces de producir case2. PARTIAL escribe únicamente precios
 * (partial-commit-fenced-write.ts:63-76) y PRICE_ONLY retorna antes del removal
 * (upsert-catalog-products.ts:212-248): ninguno de los dos puede generar el material.
 */
export function shouldRunEndOfAttemptConsistency(s: EndOfAttemptSignals): boolean {
  return s.fullUpsertAttempted;
}

export interface EndOfAttemptResult {
  scanned: number;
  fixed: number;
  errors: number;
}

/**
 * case2 acotado a un proveedor: `pub.status='ACTIVE' ∧ cp.supplierStatus='SUPPLIER_REMOVED' ∧
 * cp.stockSource='SUPPLIER'`, restringido a `cp.providerId = providerId`.
 *
 * Correr el chequeo GLOBAL al final de una extracción sería ampliación de autoridad: un evento
 * humano ("extraé este proveedor") dispararía escrituras y pushes a Woo sobre publications de
 * otros proveedores.
 *
 * NUNCA lanza: un fallo de T2 no puede alterar el estado terminal del job.
 */
export async function runEndOfAttemptConsistency(
  prisma: PrismaClient,
  args: { providerId: string; jobId: string },
): Promise<EndOfAttemptResult> {
  const result: EndOfAttemptResult = { scanned: 0, fixed: 0, errors: 0 };

  try {
    const targets = await prisma.productPublication.findMany({
      where: {
        status: "ACTIVE",
        catalogProduct: {
          is: {
            providerId: args.providerId,
            supplierStatus: "SUPPLIER_REMOVED",
            stockSource: "SUPPLIER",
          },
        },
      },
      select: { id: true, catalogProductId: true, storeId: true },
    });
    result.scanned = targets.length;
    if (targets.length === 0) return result;

    const clientByStore = new Map<string, WooCommerceClient | null>();
    for (const pub of targets) {
      try {
        if (!clientByStore.has(pub.storeId)) {
          const store = await prisma.store.findUnique({
            where: { id: pub.storeId },
            include: { integrations: { orderBy: { createdAt: "desc" }, take: 1 } },
          });
          const integration = store?.integrations[0];
          clientByStore.set(
            pub.storeId,
            store && integration
              ? WooCommerceClient.fromIntegration({
                  storeUrl: store.url,
                  consumerKeyEncrypted: integration.consumerKeyEncrypted,
                  consumerSecretEncrypted: integration.consumerSecretEncrypted,
                })
              : null,
          );
        }
        const client = clientByStore.get(pub.storeId) ?? null;
        if (!client) {
          result.errors++;
          continue;
        }
        const r = await pauseProductInWoo(prisma, client, pub.storeId, pub.catalogProductId);
        if (r.success) {
          result.fixed++;
          await logWarning({
            source: "WORKER",
            type: "CONSISTENCY_FIX",
            title: "Consistencia (fin de extracción): pub ACTIVE con proveedor removido → pausado",
            productId: pub.catalogProductId,
            publicationId: pub.id,
            storeId: pub.storeId,
            providerId: args.providerId,
            jobId: args.jobId,
            metadata: { case: "ACTIVE_WITH_SUPPLIER_REMOVED", trigger: "T2_END_OF_ATTEMPT" },
          });
        } else {
          result.errors++;
        }
      } catch {
        result.errors++;
      }
    }
  } catch (err) {
    // T2 no puede tumbar nada: se traga la excepción y deja testigo.
    result.errors++;
    await logError({
      source: "WORKER",
      type: "CONSISTENCY_CHECK_ERROR",
      title: "T2 (fin de extracción) falló",
      description: err instanceof Error ? err.message : String(err),
      providerId: args.providerId,
      jobId: args.jobId,
      metadata: { trigger: "T2_END_OF_ATTEMPT" },
    });
  }

  return result;
}
