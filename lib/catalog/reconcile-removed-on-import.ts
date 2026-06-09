// Reconciliación de productos removidos por proveedor durante un import.
// Extraído de app/api/catalog/import/route.ts para ser testeable con un
// PrismaClient inyectado (el route usa el prisma de prod y no se testea directo).
//
// 1A.2-import — el fix central: la auto-pausa ahora setea pausedBySystem=true
// (igual que el worker en upsert-catalog-products.ts), para que la reaparición
// del proveedor (B / handleReappeared, que sólo reactiva si pausedBySystem=true)
// vuelva a publicar. ANTES el import dejaba pausedBySystem=false → B lo
// interpretaba como pausa manual y nunca reactivaba.
//
// Estrategia: ENCOLAR (no push Woo dentro del import). La pp queda
// PENDING_SYNC + pendingSync=true y pp.status=ACTIVE; el consistency-check del
// worker (Caso 2: ACTIVE + SUPPLIER_REMOVED + stockSource=SUPPLIER) y el drainer
// manual ("Sincronizar pendientes") la bajan a draft con el contrato honesto.
// No se pushea sincrónicamente porque un import puede remover muchos productos
// de una sola vez (riesgo de latencia/timeout en el request).

import type { PrismaClient } from "@prisma/client";
import { logInfo } from "@/lib/events/event-log";

export interface ReconcileRemovedOnImportParams {
  userId: string;
  providerId: string;
  importedSkus: string[];
  importBatchId: string;
}

export interface ReconcileRemovedOnImportResult {
  /** Caso 1: PREPARED|PUBLISHED + stockSource=SUPPLIER → auto-pausados. */
  removedPaused: number;
  /** Caso 2: el resto (OWN/HYBRID, NOT_PUBLISHED, PAUSED/IGNORED…) → sólo SUPPLIER_REMOVED. */
  removedRest: number;
  pausedIds: string[];
}

export async function reconcileRemovedOnImport(
  prisma: PrismaClient,
  { userId, providerId, importedSkus, importBatchId }: ReconcileRemovedOnImportParams
): Promise<ReconcileRemovedOnImportResult> {
  if (importedSkus.length === 0) {
    return { removedPaused: 0, removedRest: 0, pausedIds: [] };
  }

  const baseWhere = {
    userId,
    providerId,
    supplierStatus: "ACTIVE" as const,
    sourceType: { in: ["SCRAPED", "IMPORTED"] as ("SCRAPED" | "IMPORTED")[] },
    sku: { notIn: importedSkus },
  };

  // Caso 1: PREPARED|PUBLISHED + stockSource=SUPPLIER → SUPPLIER_REMOVED + PAUSED
  // + pausedBySystem=true. Filtro POSITIVO stockSource="SUPPLIER" (OWN/HYBRID
  // sobreviven). internalStatus∈[PREPARED,PUBLISHED] (no toca PAUSED/IGNORED →
  // las pausas manuales se preservan).
  const toAutoPause = await prisma.catalogProduct.findMany({
    where: {
      ...baseWhere,
      stockSource: "SUPPLIER",
      internalStatus: { in: ["PREPARED", "PUBLISHED"] },
    },
    select: { id: true },
  });
  const pausedIds = toAutoPause.map((p) => p.id);
  let removedPaused = 0;

  if (pausedIds.length > 0) {
    const r = await prisma.catalogProduct.updateMany({
      where: { id: { in: pausedIds } },
      data: {
        supplierStatus: "SUPPLIER_REMOVED",
        internalStatus: "PAUSED",
        // 1A.2-import: marca de pausa automática para que B reactive al reaparecer.
        pausedBySystem: true,
      },
    });
    removedPaused = r.count;
    // Las pp ACTIVE quedan desincronizadas (PricEcom=PAUSED, Woo=publish):
    // marcamos PENDING_SYNC para que el consistency-check / drainer las baje a draft.
    await prisma.productPublication.updateMany({
      where: { catalogProductId: { in: pausedIds }, status: "ACTIVE" },
      data: { pendingSync: true, syncStatus: "PENDING_SYNC" },
    });

    if (removedPaused > 0) {
      await logInfo({
        source: "SYNC",
        type: "PRODUCT_AUTO_PAUSED",
        title: `${removedPaused} producto(s) auto-pausados durante import (supplier removed)`,
        userId,
        providerId,
        metadata: {
          productIds: pausedIds,
          count: removedPaused,
          reason: "supplier_removed_during_import",
          newStatus: "PAUSED",
          pausedBySystem: true,
          importBatchId,
        },
      });
    }
  }

  // Caso 2: el resto (excepto IGNORED y el Caso 1) → sólo SUPPLIER_REMOVED.
  // OWN/HYBRID y pausas manuales caen acá: sobreviven sin auto-pausa.
  const removedRest = await prisma.catalogProduct.updateMany({
    where: {
      ...baseWhere,
      internalStatus: { not: "IGNORED" },
      NOT: {
        AND: [
          { stockSource: "SUPPLIER" },
          { internalStatus: { in: ["PREPARED", "PUBLISHED"] } },
        ],
      },
    },
    data: { supplierStatus: "SUPPLIER_REMOVED" },
  });

  return { removedPaused, removedRest: removedRest.count, pausedIds };
}
