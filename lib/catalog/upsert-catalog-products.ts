// Mantenemos el import relativo (no `@/...`) porque este módulo lo consume el
// worker (tsx) además de Next.js, y el alias `@` puede no resolver en tsx.
import type { PrismaClient } from "@prisma/client";
import { createHash } from "crypto";
import { logInfo, logWarning } from "../events/event-log";
import { WooCommerceClient } from "../integrations/woocommerce/client";
import {
  pauseProductInWoo,
  publishProductToWoo,
} from "../integrations/woocommerce/publication-service";
import type { PricingRuleForCalc } from "../pricing/pricing-engine";
import { markPublicationsDrift } from "./mark-publications-drift";
import { toCatalogUpperCase, toCatalogUpperCaseOrNull } from "./uppercase";

interface IdentityInputs {
  sku?: string | null;
  productUrl?: string | null;
  name: string;
  providerId: string;
}

interface IdentityKey {
  sku?: string;
  productUrl?: string;
  identityHash?: string;
}

function identityKey(p: IdentityInputs): IdentityKey {
  if (p.sku?.trim()) return { sku: p.sku.trim() };
  if (p.productUrl?.trim()) return { productUrl: p.productUrl.trim() };
  const hash = createHash("sha256")
    .update((p.name + p.providerId).toLowerCase().trim())
    .digest("hex")
    .slice(0, 16);
  return { identityHash: hash };
}

/**
 * Upsert de CatalogProduct para todos los productos extraídos en `jobId`.
 *
 * Reglas:
 *  - Sólo los campos `supplier*` y `lastSeenAt` se actualizan automáticamente.
 *  - Los campos comerciales (commercialName, assignedCategory, manualPrice,
 *    pricingRule, notes) NUNCA se tocan en updates.
 *  - Productos del proveedor que ya estaban en el catálogo pero no aparecieron
 *    en esta extracción se marcan como `SUPPLIER_REMOVED`.
*  - Si un producto reaparece tras estar SUPPLIER_REMOVED:
 *      · `supplierStatus` vuelve a ACTIVE siempre.
 *      · Si estaba PAUSED por el sistema (pausedBySystem=true) → reactiva
 *        automáticamente: internalStatus=PUBLISHED, pausedBySystem=false,
 *        push inmediato a Woo y log PRODUCT_REACTIVATED.
 *      · Si la pausa era manual del usuario (pausedBySystem=false) → no toca
 *        internalStatus; solo loguea PRODUCT_REAPPEARED para que el usuario
 *        decida si reactivar.
 */
export async function upsertCatalogProducts(
  jobId: string,
  prismaClient: PrismaClient
): Promise<void> {
  const job = await prismaClient.extractionJob.findUnique({
    where: { id: jobId },
    include: { products: true },
  });
  if (!job || !job.userId) return;

  const userId = job.userId;
  const providerId = job.providerId;
  const lastSeenAt = new Date();

  // Fase 3 lazy SKU: el worker NO genera publicationSku ni asigna SKU
  // comercial. El SKU se asigna lazy al publicar en publishProductToWoo,
  // como provider.skuPrefix + cp.sku. La columna CatalogProduct.publicationSku
  // queda para compatibilidad hasta Fase 5; el scraperConfig.imageFilenamePrefix
  // sigue existiendo (para nombres de archivos de imágenes), pero ya no se
  // lee acá.

  // Las pricing rules se cargan una vez por job: las necesita
  // publishProductToWoo cuando reactivamos automáticamente un producto que
  // volvió del SUPPLIER_REMOVED. Si no hay reactivaciones en este job, la
  // carga es barata (lista corta).
  const pricingRules = (await prismaClient.pricingRule.findMany({
    where: { userId, isActive: true },
    select: {
      id: true,
      name: true,
      scope: true,
      scopeId: true,
      marginPercent: true,
      roundingMode: true,
      isActive: true,
      priority: true,
    },
  })) as PricingRuleForCalc[];

  // Cache de WooCommerceClient por storeId. Lazy: solo construimos clientes
  // cuando una reactivación nos obliga a pushear. Si las credenciales fallan,
  // guardamos `null` para no reintentar instanciar en cada iteración.
  const clientByStore = new Map<string, WooCommerceClient | null>();
  async function getWooClient(
    storeId: string
  ): Promise<WooCommerceClient | null> {
    if (clientByStore.has(storeId)) return clientByStore.get(storeId) ?? null;
    const store = await prismaClient.store.findFirst({
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

  // Handler de reactivación / reaparición. Lo llamamos justo después del
  // update del CatalogProduct, cuando detectamos que venía de SUPPLIER_REMOVED.
  // wholesalePrice ya fue actualizado por supplierDataBase, así que el motor
  // de pricing tiene el precio fresco antes del push.
  async function handleReappeared(pre: {
    id: string;
    sku: string | null;
    supplierName: string;
    internalStatus: string;
    pausedBySystem: boolean;
  }): Promise<void> {
    if (pre.internalStatus !== "PAUSED") return;

    if (pre.pausedBySystem) {
      // Reactivación automática.
      await prismaClient.catalogProduct.update({
        where: { id: pre.id },
        data: { internalStatus: "PUBLISHED", pausedBySystem: false },
      });

      const pubs = await prismaClient.productPublication.findMany({
        where: { catalogProductId: pre.id },
        select: { storeId: true },
      });
      for (const pub of pubs) {
        const client = await getWooClient(pub.storeId);
        if (!client) continue;
        // publishProductToWoo loguea WOO_SYNC_ERROR internamente si falla.
        // No revertimos internalStatus: el producto queda PUBLISHED en
        // PricEcom y la próxima detección de drift lo marca OUTDATED para
        // que el usuario lo resync manualmente desde Mi Tienda.
        await publishProductToWoo(
          prismaClient,
          client,
          pub.storeId,
          pre.id,
          pricingRules
        );
      }

      await logInfo({
        source: "WORKER",
        type: "PRODUCT_REACTIVATED",
        title: `Producto reactivado automáticamente — SKU ${pre.sku ?? "(sin SKU)"}`,
        description: "El proveedor volvió a tener el producto disponible.",
        productId: pre.id,
        providerId,
        jobId,
        metadata: {
          sku: pre.sku,
          supplierName: pre.supplierName,
          previousStatus: "PAUSED",
        },
      });
    } else {
      // Pausa manual del usuario — no tocamos internalStatus, solo notificamos.
      await logInfo({
        source: "WORKER",
        type: "PRODUCT_REAPPEARED",
        title: `Producto volvió a estar disponible — SKU ${pre.sku ?? "(sin SKU)"}`,
        description:
          "El proveedor tiene el producto nuevamente. Revisá si querés reactivarlo.",
        productId: pre.id,
        providerId,
        jobId,
        metadata: { sku: pre.sku, supplierName: pre.supplierName },
      });
    }
  }

  // Acumulamos los cps cuyo wholesalePrice cambió respecto al valor previo.
  // Al final del loop pasamos esta lista a markPublicationsDrift para que las
  // pp asociadas queden marcadas como OUTDATED y aparezcan en "Sincronizar
  // pendientes". markPublicationsDrift re-evalúa el drift contra priceInStore
  // antes de marcar (no marca a ciegas), así que productos sin pp publicada
  // o con drift sub-tolerancia no generan ruido.
  const WHOLESALE_TOLERANCE = 0.005;
  const drifted: string[] = [];

  for (const product of job.products) {
    const identity = identityKey({
      sku: product.sku,
      productUrl: product.productUrl,
      name: product.name,
      providerId,
    });

    // Datos que el worker puede actualizar (siempre supplier*, nunca comerciales).
    // publicationSku ya NO se setea acá (Fase 3 lazy): el SKU comercial se
    // asigna lazy al publicar en publishProductToWoo, vía ProductPublication.sku.
    const supplierDataBase = {
      supplierName: toCatalogUpperCase(product.name),
      supplierDescription: toCatalogUpperCaseOrNull(product.description),
      wholesalePrice:
        product.wholesalePrice != null ? Number(product.wholesalePrice) : null,
      stock: product.stock ?? null,
      supplierCategory: product.category ?? null,
      imageUrl: product.imageUrl ?? null,
      productUrl: product.productUrl ?? null,
      lastSeenAt,
      supplierStatus: "ACTIVE" as const,
      latestExtractedProductId: product.id,
    };

    let upsertedId: string | null = null;
    if (identity.sku) {
      const existing = await prismaClient.catalogProduct.findUnique({
        where: {
          userId_providerId_sku: {
            userId,
            providerId,
            sku: identity.sku,
          },
        },
        select: {
          id: true,
          sku: true,
          supplierName: true,
          supplierStatus: true,
          internalStatus: true,
          pausedBySystem: true,
          // wholesalePrice (previo) para detectar drift de precio: si el
          // nuevo valor difiere, marcamos la pp como OUTDATED al final del
          // loop. Sin esto, una baja de precio del proveedor se persiste en
          // el cp pero la pp se queda "SYNCED" mintiendo, y el botón
          // "Sincronizar pendientes" no la encuentra → Woo nunca recibe el
          // precio nuevo.
          wholesalePrice: true,
        },
      });

      if (existing) {
        const cameBackFromRemoved =
          existing.supplierStatus === "SUPPLIER_REMOVED";
        // Detectar cambio de wholesalePrice ANTES del update, para acumular
        // el id en `drifted` si corresponde. La marca de drift se aplica
        // después del loop (markPublicationsDrift re-evalúa contra priceInStore).
        const previousWs =
          existing.wholesalePrice == null ? null : Number(existing.wholesalePrice);
        const newWs = supplierDataBase.wholesalePrice;
        const wholesaleChanged =
          (previousWs == null) !== (newWs == null) ||
          (previousWs != null &&
            newWs != null &&
            Math.abs(previousWs - newWs) > WHOLESALE_TOLERANCE);
        await prismaClient.catalogProduct.update({
          where: { id: existing.id },
          data: supplierDataBase,
        });
        upsertedId = existing.id;
        if (wholesaleChanged) drifted.push(existing.id);
        if (cameBackFromRemoved) {
          await handleReappeared({
            id: existing.id,
            sku: existing.sku,
            supplierName: existing.supplierName,
            internalStatus: existing.internalStatus,
            pausedBySystem: existing.pausedBySystem,
          });
        }
      } else {
        const created = await prismaClient.catalogProduct.create({
          data: {
            userId,
            providerId,
            sku: identity.sku,
            ...supplierDataBase,
          },
          select: { id: true },
        });
        upsertedId = created.id;
      }
    } else {
      // Sin SKU: buscar manualmente por productUrl o identityHash dentro del scope
      // userId×providerId. Si no hay ninguno de los dos, no podemos identificar.
      const orClauses: Array<
        | { productUrl: string }
        | { identityHash: string }
      > = [];
      if (identity.productUrl) orClauses.push({ productUrl: identity.productUrl });
      if (identity.identityHash) orClauses.push({ identityHash: identity.identityHash });

      if (orClauses.length === 0) continue;

      const existing = await prismaClient.catalogProduct.findFirst({
        where: { userId, providerId, OR: orClauses },
        select: {
          id: true,
          sku: true,
          supplierName: true,
          supplierStatus: true,
          internalStatus: true,
          pausedBySystem: true,
          // wholesalePrice (previo) para detectar drift de precio: si el
          // nuevo valor difiere, marcamos la pp como OUTDATED al final del
          // loop. Sin esto, una baja de precio del proveedor se persiste en
          // el cp pero la pp se queda "SYNCED" mintiendo, y el botón
          // "Sincronizar pendientes" no la encuentra → Woo nunca recibe el
          // precio nuevo.
          wholesalePrice: true,
        },
      });

      if (existing) {
        const cameBackFromRemoved =
          existing.supplierStatus === "SUPPLIER_REMOVED";
        // Mismo patrón que en el branch con SKU: detectar cambio antes del
        // update y acumular en `drifted` si corresponde.
        const previousWs =
          existing.wholesalePrice == null ? null : Number(existing.wholesalePrice);
        const newWs = supplierDataBase.wholesalePrice;
        const wholesaleChanged =
          (previousWs == null) !== (newWs == null) ||
          (previousWs != null &&
            newWs != null &&
            Math.abs(previousWs - newWs) > WHOLESALE_TOLERANCE);
        await prismaClient.catalogProduct.update({
          where: { id: existing.id },
          data: supplierDataBase,
        });
        upsertedId = existing.id;
        if (wholesaleChanged) drifted.push(existing.id);
        if (cameBackFromRemoved) {
          await handleReappeared({
            id: existing.id,
            sku: existing.sku,
            supplierName: existing.supplierName,
            internalStatus: existing.internalStatus,
            pausedBySystem: existing.pausedBySystem,
          });
        }
      } else {
        const created = await prismaClient.catalogProduct.create({
          data: {
            userId,
            providerId,
            ...(identity.productUrl ? { productUrl: identity.productUrl } : {}),
            ...(identity.identityHash ? { identityHash: identity.identityHash } : {}),
            ...supplierDataBase,
          },
          select: { id: true },
        });
        upsertedId = created.id;
      }
    }

    // Propagar el wholesalePrice actualizado a productos derivados con
    // stockSource=OWN que apunten a este catálogo via sourceCatalogProductId.
    // Solo wholesalePrice — los datos comerciales del hijo son del usuario y no
    // se tocan. En el modelo nuevo no se crean más duplicados (copy_own_stock
    // setea stockSource sobre la misma fila), pero conservamos este puente por
    // si quedan registros legacy de instalaciones previas.
    if (upsertedId && supplierDataBase.wholesalePrice != null) {
      await prismaClient.catalogProduct.updateMany({
        where: {
          sourceCatalogProductId: upsertedId,
          stockSource: "OWN",
        },
        data: { wholesalePrice: supplierDataBase.wholesalePrice },
      });
    }
  }

  // Marcar como OUTDATED las ProductPublication de los cps cuyos
  // wholesalePrice cambió. markPublicationsDrift re-evalúa internamente con
  // resolvePricing (mismo motor que publishProductToWoo) — sólo marca si hay
  // drift real contra priceInStore. Productos sin pp publicada, o con
  // diferencia sub-tolerancia post-recálculo, no generan ruido.
  // No empuja a Woo: el push sigue siendo decisión manual del usuario via
  // "Sincronizar pendientes". Acá solo aseguramos que las pp efectivamente
  // aparezcan en esa cola.
  if (drifted.length > 0) {
    await markPublicationsDrift(prismaClient, drifted);
  }

  // Marcar como SUPPLIER_REMOVED los CatalogProduct activos de este proveedor
  // cuyo SKU no apareció en la extracción actual. Sólo aplicamos a productos con
  // SKU: los identificados por URL/hash son menos confiables para detectar bajas.
  //
  // Auto-pause: si el producto está PREPARED y depende del proveedor (stockSource
  // SUPPLIER), además de marcarlo removido lo pasamos a PAUSED para evitar que se
  // publique algo que ya no tenemos cómo abastecer. Los OWN y HYBRID conservan
  // internalStatus porque el cliente tiene stock propio. IGNORED no se toca.
  const seenSkus = job.products
    .map((p) => p.sku)
    .filter((s): s is string => !!s && s.length > 0);

  if (seenSkus.length > 0) {
    // Caso 1: PREPARED|PUBLISHED + stockSource SUPPLIER → PAUSED + SUPPLIER_REMOVED.
    // Pre-resolvemos los IDs para poder propagar el cambio a ProductPublication
    // (marcarlas pendingSync=true) en el mismo paso.
    const toAutoPause = await prismaClient.catalogProduct.findMany({
      where: {
        userId,
        providerId,
        supplierStatus: "ACTIVE",
        stockSource: "SUPPLIER",
        internalStatus: { in: ["PREPARED", "PUBLISHED"] },
        sku: { notIn: seenSkus },
      },
      select: { id: true, sku: true, supplierName: true, internalStatus: true },
    });

    if (toAutoPause.length > 0) {
      const pauseIds = toAutoPause.map((p) => p.id);
      await prismaClient.catalogProduct.updateMany({
        where: { id: { in: pauseIds } },
        data: {
          supplierStatus: "SUPPLIER_REMOVED",
          internalStatus: "PAUSED",
          // Marca de pausa automática: si el proveedor vuelve a traer el
          // producto, el upsert lo reactivará solo.
          pausedBySystem: true,
        },
      });
      // Las publications que estaban ACTIVE quedan desincronizadas: marcamos
      // pendingSync=true como red de seguridad, pero a continuación
      // intentamos pushear inmediatamente a Woo. Si el push tiene éxito,
      // pauseProductInWoo resetea pendingSync=false y status=PAUSED en la
      // misma publication.
      await prismaClient.productPublication.updateMany({
        where: {
          catalogProductId: { in: pauseIds },
          status: "ACTIVE",
        },
        data: { pendingSync: true, syncStatus: "PENDING_SYNC" },
      });

      // Audit trail: un evento por producto auto-pausado.
      for (const p of toAutoPause) {
        await logWarning({
          source: "SYSTEM",
          type: "PRODUCT_AUTO_PAUSED",
          title: `Producto pausado automáticamente — SKU ${p.sku ?? "(sin SKU)"}`,
          description: "El proveedor removió el producto del catálogo.",
          productId: p.id,
          providerId,
          jobId,
          metadata: {
            previousStatus: p.internalStatus,
            sku: p.sku,
            supplierName: p.supplierName,
          },
        });
      }

      // Push inmediato a WooCommerce. Loadeamos las publications ACTIVE
      // (después del updateMany ya pasaron a PAUSED en DB, pero el
      // externalStatus sigue siendo "publish" en Woo). Construimos un
      // WooCommerceClient por cada store afectado y disparamos pauseProductInWoo.
      // Si Woo falla, pauseProductInWoo loguea WOO_SYNC_ERROR y deja la
      // publication con syncStatus=ERROR + pendingSync=true para retry.
      const pubsToPause = await prismaClient.productPublication.findMany({
        where: {
          catalogProductId: { in: pauseIds },
          externalProductId: { not: null },
        },
        select: { id: true, catalogProductId: true, storeId: true },
      });

      if (pubsToPause.length > 0) {
        const clientByStore = new Map<string, WooCommerceClient>();
        const distinctStoreIds = Array.from(
          new Set(pubsToPause.map((p) => p.storeId))
        );
        for (const sid of distinctStoreIds) {
          const store = await prismaClient.store.findFirst({
            where: { id: sid, userId },
            include: {
              integrations: { orderBy: { createdAt: "desc" }, take: 1 },
            },
          });
          const integration = store?.integrations[0];
          if (!store || !integration) continue;
          try {
            clientByStore.set(
              sid,
              WooCommerceClient.fromIntegration({
                storeUrl: store.url,
                consumerKeyEncrypted: integration.consumerKeyEncrypted,
                consumerSecretEncrypted: integration.consumerSecretEncrypted,
              })
            );
          } catch {
            // sin credenciales válidas — la publication queda PENDING_SYNC
            // y el usuario puede reintentar desde Mi Tienda.
          }
        }

        for (const pub of pubsToPause) {
          const client = clientByStore.get(pub.storeId);
          if (!client) continue;
          // pauseProductInWoo maneja su propio try/catch + logging — si Woo
          // falla, no rompe el worker.
          await pauseProductInWoo(
            prismaClient,
            client,
            pub.storeId,
            pub.catalogProductId
          );
        }
      }
    }

    // Caso 2: el resto (NOT_PUBLISHED, PAUSED, o cualquier estado con stockSource
    // OWN/HYBRID) → sólo marcar SUPPLIER_REMOVED. IGNORED queda excluido.
    // Pre-resolvemos también acá para loguear PRODUCT_SUPPLIER_REMOVED.
    const toMarkRemoved = await prismaClient.catalogProduct.findMany({
      where: {
        userId,
        providerId,
        supplierStatus: "ACTIVE",
        internalStatus: { not: "IGNORED" },
        sku: { notIn: seenSkus },
        NOT: {
          AND: [
            { stockSource: "SUPPLIER" },
            { internalStatus: { in: ["PREPARED", "PUBLISHED"] } },
          ],
        },
      },
      select: { id: true, sku: true, supplierName: true },
    });
    if (toMarkRemoved.length > 0) {
      await prismaClient.catalogProduct.updateMany({
        where: { id: { in: toMarkRemoved.map((p) => p.id) } },
        data: { supplierStatus: "SUPPLIER_REMOVED" },
      });
      for (const p of toMarkRemoved) {
        await logWarning({
          source: "WORKER",
          type: "PRODUCT_SUPPLIER_REMOVED",
          title: `Producto removido por proveedor — SKU ${p.sku ?? "(sin SKU)"}`,
          productId: p.id,
          providerId,
          jobId,
          metadata: { sku: p.sku, supplierName: p.supplierName },
        });
      }
    }
  }
}
