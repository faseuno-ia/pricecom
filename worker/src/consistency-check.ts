// Job de consistencia: detecta combinaciones inválidas entre ProductPublication
// y CatalogProduct y las corrige. Corre periódicamente desde el worker.
//
// Tres casos que cubre:
//   1. pub=DRAFT + internalStatus=PAUSED + supplierStatus=ACTIVE
//      → solo cambio en DB: pub.status = PAUSED. DRAFT es un estado legacy
//        del mapper antiguo (sync Woo → PricEcom).
//   2. pub=ACTIVE + supplierStatus=SUPPLIER_REMOVED
//      → producto removido por el proveedor pero la publication sigue ACTIVE
//        en la DB y posiblemente "publish" en Woo. pauseProductInWoo se
//        encarga del push y deja syncStatus correcto.
//   3. pub=ACTIVE + internalStatus=PAUSED + supplierStatus=ACTIVE
//      → el usuario pausó pero el push a Woo no se completó. pauseProductInWoo
//        reintenta. (Si Woo devuelve 404, queda capturado en syncError; el
//        operador puede limpiar manualmente con cleanup-orphan-publications.)
//
// Nunca tira excepción: cada caso va en su try/catch para que un fallo no
// cancele la siguiente verificación, y la función entera está envuelta donde
// se la llama.

import type { PrismaClient } from "@prisma/client";
import { WooCommerceClient } from "../../lib/integrations/woocommerce/client";
import { pauseProductInWoo } from "../../lib/integrations/woocommerce/publication-service";
import { logInfo, logWarning, logError } from "../../lib/events/event-log";

export async function runConsistencyCheck(prisma: PrismaClient): Promise<void> {
  console.log("[consistency] iniciando chequeo...");
  const startedAt = Date.now();

  // Cache lazy de WooCommerceClient por storeId. Si las credenciales fallan
  // guardamos `null` para no reintentar instanciar en cada iteración.
  const clientByStore = new Map<string, WooCommerceClient | null>();
  async function getClient(storeId: string): Promise<WooCommerceClient | null> {
    if (clientByStore.has(storeId)) return clientByStore.get(storeId) ?? null;
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      include: { integrations: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    const integration = store?.integrations[0];
    if (!store || !integration) {
      clientByStore.set(storeId, null);
      return null;
    }
    try {
      const client = WooCommerceClient.fromIntegration({
        storeUrl: store.url,
        consumerKeyEncrypted: integration.consumerKeyEncrypted,
        consumerSecretEncrypted: integration.consumerSecretEncrypted,
      });
      clientByStore.set(storeId, client);
      return client;
    } catch {
      clientByStore.set(storeId, null);
      return null;
    }
  }

  // ── Caso 1: DRAFT + PAUSED + supplier ACTIVE → PAUSED ────────────────────
  let case1 = 0;
  try {
    const draftPaused = await prisma.productPublication.findMany({
      where: {
        status: "DRAFT",
        catalogProduct: {
          is: { internalStatus: "PAUSED", supplierStatus: "ACTIVE" },
        },
      },
      select: { id: true },
    });
    if (draftPaused.length > 0) {
      const res = await prisma.productPublication.updateMany({
        where: { id: { in: draftPaused.map((p) => p.id) } },
        data: { status: "PAUSED" },
      });
      case1 = res.count;
      await logWarning({
        source: "WORKER",
        type: "CONSISTENCY_FIX",
        title: `Consistencia: ${res.count} publication(s) DRAFT → PAUSED`,
        description:
          "Publications con estado DRAFT (legacy) y CatalogProduct PAUSED — se igualan.",
        metadata: {
          case: "DRAFT_TO_PAUSED",
          count: res.count,
          publicationIds: draftPaused.map((p) => p.id),
        },
      });
    }
  } catch (err) {
    await logError({
      source: "WORKER",
      type: "CONSISTENCY_CHECK_ERROR",
      title: "Consistencia: error en caso 1 (DRAFT → PAUSED)",
      description: err instanceof Error ? err.message : String(err),
      metadata: { case: "DRAFT_TO_PAUSED" },
    });
  }

  // ── Caso 2: ACTIVE + supplier SUPPLIER_REMOVED → pauseProductInWoo ───────
  let case2Fixed = 0;
  let case2Errors = 0;
  try {
    const activeRemoved = await prisma.productPublication.findMany({
      where: {
        status: "ACTIVE",
        catalogProduct: { is: { supplierStatus: "SUPPLIER_REMOVED" } },
      },
      select: { id: true, catalogProductId: true, storeId: true },
    });
    for (const pub of activeRemoved) {
      const client = await getClient(pub.storeId);
      if (!client) {
        case2Errors++;
        continue;
      }
      const res = await pauseProductInWoo(
        prisma,
        client,
        pub.storeId,
        pub.catalogProductId
      );
      if (res.success) {
        case2Fixed++;
        await logWarning({
          source: "WORKER",
          type: "CONSISTENCY_FIX",
          title: "Consistencia: pub ACTIVE con proveedor removido → pausado",
          publicationId: pub.id,
          productId: pub.catalogProductId,
          storeId: pub.storeId,
          metadata: { case: "ACTIVE_WITH_SUPPLIER_REMOVED" },
        });
      } else {
        case2Errors++;
      }
    }
  } catch (err) {
    await logError({
      source: "WORKER",
      type: "CONSISTENCY_CHECK_ERROR",
      title: "Consistencia: error en caso 2 (ACTIVE + SUPPLIER_REMOVED)",
      description: err instanceof Error ? err.message : String(err),
      metadata: { case: "ACTIVE_WITH_SUPPLIER_REMOVED" },
    });
  }

  // ── Caso 3: ACTIVE + internal PAUSED + supplier ACTIVE → pauseProductInWoo ─
  let case3Fixed = 0;
  let case3Errors = 0;
  try {
    const activePaused = await prisma.productPublication.findMany({
      where: {
        status: "ACTIVE",
        catalogProduct: {
          is: { internalStatus: "PAUSED", supplierStatus: "ACTIVE" },
        },
      },
      select: { id: true, catalogProductId: true, storeId: true },
    });
    for (const pub of activePaused) {
      const client = await getClient(pub.storeId);
      if (!client) {
        case3Errors++;
        continue;
      }
      const res = await pauseProductInWoo(
        prisma,
        client,
        pub.storeId,
        pub.catalogProductId
      );
      if (res.success) {
        case3Fixed++;
        await logWarning({
          source: "WORKER",
          type: "CONSISTENCY_FIX",
          title: "Consistencia: pub ACTIVE con producto pausado → pausado",
          publicationId: pub.id,
          productId: pub.catalogProductId,
          storeId: pub.storeId,
          metadata: { case: "ACTIVE_WITH_INTERNAL_PAUSED" },
        });
      } else {
        case3Errors++;
      }
    }
  } catch (err) {
    await logError({
      source: "WORKER",
      type: "CONSISTENCY_CHECK_ERROR",
      title: "Consistencia: error en caso 3 (ACTIVE + internal PAUSED)",
      description: err instanceof Error ? err.message : String(err),
      metadata: { case: "ACTIVE_WITH_INTERNAL_PAUSED" },
    });
  }

  const totalFixed = case1 + case2Fixed + case3Fixed;
  const totalErrors = case2Errors + case3Errors;
  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[consistency] terminado en ${elapsedMs}ms — case1=${case1}, case2=${case2Fixed}/${case2Fixed + case2Errors}, case3=${case3Fixed}/${case3Fixed + case3Errors}`
  );

  // Heartbeat informativo solo cuando hay corrección o error: evita spamear el
  // EventLog con "0 cambios" cada 5 minutos.
  if (totalFixed > 0 || totalErrors > 0) {
    await logInfo({
      source: "WORKER",
      type: "CONSISTENCY_CHECK_RUN",
      title: `Consistency check: ${totalFixed} fix${totalFixed !== 1 ? "es" : ""}${totalErrors > 0 ? `, ${totalErrors} error(es)` : ""}`,
      metadata: {
        elapsedMs,
        case1DraftToPaused: case1,
        case2ActiveWithSupplierRemoved: case2Fixed,
        case2Errors,
        case3ActiveWithInternalPaused: case3Fixed,
        case3Errors,
      },
    });
  }
}
