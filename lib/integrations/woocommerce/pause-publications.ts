// Orquestación del push de pausa a WooCommerce para un set de CatalogProducts
// (acción manual pause/ignore desde bulk-update). Extraído de bulk-update/route.ts
// para ser testeable con un PrismaClient inyectado (las rutas usan el prisma de
// prod y no se pueden testear directo).
//
// 1A.2-ab — agujero sin credenciales tapado: si una store no tiene credenciales,
// ANTES se hacía `continue` silencioso y la publication quedaba ACTIVE/publish
// invisible (PricEcom=PAUSED / Woo=publish sin marca). AHORA se marca
// PENDING_SYNC + pendingSync=true para que quede visible y la tome el drainer
// ("Sincronizar pendientes").

import type { PrismaClient } from "@prisma/client";
import { WooCommerceClient } from "./client";
import { pauseProductInWoo } from "./publication-service";

export interface PausePublicationsResult {
  /** pauseProductInWoo exitoso (Woo quedó draft, syncStatus=SYNCED). */
  pushed: number;
  /** pauseProductInWoo falló; la pp ya quedó clasificada por su catch
   *  (PENDING_SYNC o ERROR según el tipo de fallo). */
  failed: number;
  /** Sin credenciales para la store → pp marcada PENDING_SYNC (en cola). */
  pendingNoClient: number;
}

export async function pausePublicationsForCatalogProducts(
  prisma: PrismaClient,
  userId: string,
  catalogProductIds: string[]
): Promise<PausePublicationsResult> {
  const result: PausePublicationsResult = { pushed: 0, failed: 0, pendingNoClient: 0 };
  if (catalogProductIds.length === 0) return result;

  const publications = await prisma.productPublication.findMany({
    where: { catalogProductId: { in: catalogProductIds }, status: "ACTIVE" },
    select: { id: true, catalogProductId: true, storeId: true },
  });
  if (publications.length === 0) return result;

  // Client por store (cache). null = sin credenciales.
  const clientByStore = new Map<string, WooCommerceClient | null>();
  async function getClient(storeId: string): Promise<WooCommerceClient | null> {
    if (clientByStore.has(storeId)) return clientByStore.get(storeId) ?? null;
    const store = await prisma.store.findFirst({
      where: { id: storeId, userId },
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

  for (const pub of publications) {
    const client = await getClient(pub.storeId);
    if (!client) {
      // Agujero sin credenciales tapado: visible + en cola (drainer).
      await prisma.productPublication.update({
        where: { id: pub.id },
        data: { syncStatus: "PENDING_SYNC", pendingSync: true },
      });
      result.pendingNoClient++;
      continue;
    }
    const res = await pauseProductInWoo(prisma, client, pub.storeId, pub.catalogProductId);
    if (res.success) result.pushed++;
    else result.failed++;
  }

  return result;
}
