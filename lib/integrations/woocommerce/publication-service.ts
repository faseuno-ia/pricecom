// Servicio que empuja un CatalogProduct concreto a WooCommerce.
// Resuelve precio vía pricing-engine, mapea categorías internas a sus
// equivalentes externos vía StoreCategory, llama al client (create/update)
// y mantiene ProductPublication + CatalogProduct.internalStatus alineados
// con el resultado.

import type { PrismaClient } from "@prisma/client";
import type { WooCommerceClient } from "./client";
import {
  resolvePricing,
  type PricingRuleForCalc,
} from "@/lib/pricing/pricing-engine";
import { logInfo, logWarning, logError } from "@/lib/events/event-log";
import { buildPublicationSku } from "@/lib/catalog/publication-sku";
import { findCollidingSkuInPricEcom } from "@/lib/catalog/sku-guards";
import { assertSkuNotInWoo } from "@/lib/integrations/woocommerce/sku-guards";
import { WooApiError, classifyWooError } from "./woo-api-error";

export interface PublishResult {
  success: boolean;
  externalProductId?: number;
  error?: string;
}

// 1A.2-ab — contrato honesto: mapea un error de Woo (catch) al EJE SYNC.
//   recoverable / ambiguous → PENDING_SYNC + pendingSync=true (reintentable; el
//     drainer "Sincronizar pendientes" lo toma). ambiguous incluye 401/403/404 y
//     parse (Woo respondió pero no se pudo interpretar).
//   terminal / unknown      → ERROR_TERMINAL + pendingSync=false (requiere
//     intervención humana; NO se reintenta solo; sale del drainer POR VALOR).
// Nunca se escribe pp.status (eje operativo): el fallo de sync vive en el eje sync.
function syncFieldsForWooError(err: unknown): {
  syncStatus: "PENDING_SYNC" | "ERROR_TERMINAL";
  pendingSync: boolean;
} {
  const cls = WooApiError.is(err) ? classifyWooError(err) : "unknown";
  if (cls === "recoverable" || cls === "ambiguous") {
    return { syncStatus: "PENDING_SYNC", pendingSync: true };
  }
  return { syncStatus: "ERROR_TERMINAL", pendingSync: false };
}

// Parsea el campo CatalogProduct.stock (string, ej. "10", "Sí", "—") a número
// entero. Devuelve null si no es interpretable como cantidad.
function parseStockQuantity(raw: string | null): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/[^\d-]/g, "");
  if (!cleaned) return null;
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) ? n : null;
}

async function resolveWooCategories(
  prisma: PrismaClient,
  storeId: string,
  categoryIds: string[]
): Promise<{ id: number }[]> {
  if (categoryIds.length === 0) return [];
  const storeCats = await prisma.storeCategory.findMany({
    where: { storeId, categoryId: { in: categoryIds } },
    select: { externalCategoryId: true },
  });
  return storeCats
    .map((c) => ({ id: parseInt(c.externalCategoryId, 10) }))
    .filter((c) => Number.isFinite(c.id));
}

export async function publishProductToWoo(
  prisma: PrismaClient,
  client: WooCommerceClient,
  storeId: string,
  catalogProductId: string,
  rules: PricingRuleForCalc[]
): Promise<PublishResult> {
  const product = await prisma.catalogProduct.findUnique({
    where: { id: catalogProductId },
    include: {
      categories: { select: { categoryId: true } },
      provider: { select: { listDiscountPercent: true, skuPrefix: true } },
    },
  });
  if (!product) return { success: false, error: "Producto no encontrado" };

  const pricing = resolvePricing(
    {
      wholesalePrice: product.wholesalePrice,
      manualMargin: product.manualMargin,
      finalPrice: product.finalPrice,
      assignedCategoryId: product.assignedCategoryId,
      providerId: product.providerId,
      listDiscountPercent: product.provider.listDiscountPercent
        ? Number(product.provider.listDiscountPercent)
        : 0,
    },
    rules
  );

  const price = pricing.effectivePrice;
  if (price == null) {
    return { success: false, error: "Sin precio calculado" };
  }

  const stockQty = parseStockQuantity(product.stock);
  const wooCategories = await resolveWooCategories(
    prisma,
    storeId,
    product.categories.map((c) => c.categoryId)
  );

  const existingPub = await prisma.productPublication.findUnique({
    where: { catalogProductId_storeId: { catalogProductId, storeId } },
    select: {
      id: true,
      sku: true,
      // externalSku es el snapshot del SKU como está en Woo. Lo usamos para
      // detectar drift entre pp.sku (PricEcom) y el SKU real en la tienda:
      // si difieren, el sync re-empuja el SKU como parte del updatePayload
      // (necesario para que el endpoint de renombre con error transitorio
      // se cierre vía pendingSync + reintento).
      externalSku: true,
      externalProductId: true,
      commercialTitle: true,
      commercialTitleUserEdited: true,
      commercialDescription: true,
      commercialDescriptionUserEdited: true,
    },
  });

  // ─── Lazy SKU (Fase 3) ──────────────────────────────────────────────────
  // Si la publication ya tiene sku asignado → usarlo (inmutable). Si no,
  // generamos provider.skuPrefix + cp.sku determinístico y lo persistimos.
  // La sanitización del sku raw NO se aplica acá: los skus anómalos (ej
  // "-0305") se preservan literal para no colisionar con sus "gemelos" sin
  // guion ("0305" = producto distinto del proveedor).
  //
  // SKU_ASSIGNED se loguea SOLO cuando el sku ya está efectivamente en DB:
  //   - UPDATE path (existingPub): log justo después del UPDATE.
  //   - CREATE path (sin existingPub): el sku se persiste en el upsert.create
  //     al final; el log se difiere y se dispara después de ese create
  //     exitoso (si el push o el create fallan, no se loguea — coherente
  //     con la realidad de DB).
  let sku: string | null = existingPub?.sku ?? null;
  let skuJustAssignedDeferred = false;

  if (!sku) {
    const generated = buildPublicationSku(
      product.provider.skuPrefix,
      product.sku
    );
    if (!generated) {
      return {
        success: false,
        error:
          "No se puede asignar SKU comercial: el producto no tiene sku del proveedor",
      };
    }
    sku = generated;

    // Colisión: warning-only en generación automática. El guard BLOQUEANTE
    // está en Fase 4B (edición manual y guard 3 contra Woo). Acá solo
    // logueamos para que el operador lo vea en el activity log. Reusamos
    // el helper compartido findCollidingSkuInPricEcom.
    const collision = await findCollidingSkuInPricEcom(
      prisma,
      product.userId,
      sku,
      { catalogProductId }
    );
    if (collision) {
      await logWarning({
        source: "SYNC",
        type: "SKU_COLLISION",
        title: `Colisión de SKU al generar lazy: ${sku}`,
        productId: catalogProductId,
        publicationId: existingPub?.id,
        storeId,
        metadata: {
          sku,
          conflictingPublicationId:
            collision.source === "publication" ? collision.id : null,
          conflictingCatalogProductId: collision.catalogProductId,
        },
      });
    }

    if (existingPub) {
      // UPDATE path: persistir el sku ANTES del push (atomicidad para retry).
      // Si después el push falla, el sku ya está en DB → log es coherente.
      await prisma.productPublication.update({
        where: { id: existingPub.id },
        data: { sku },
      });
      await logInfo({
        source: "SYNC",
        type: "SKU_ASSIGNED",
        title: `SKU comercial asignado: ${sku}`,
        productId: catalogProductId,
        publicationId: existingPub.id,
        storeId,
        metadata: {
          sku,
          providerId: product.providerId,
          catalogProductId,
        },
      });
    } else {
      // CREATE path: no hay publication donde persistir. El sku se va a
      // guardar en el upsert.create al final, después del push exitoso.
      // Difer­imos el log para que solo dispare si efectivamente queda en DB.
      // Si el push o el create fallan, nada se loguea — coherente.
      skuJustAssignedDeferred = true;
    }
  }

  const previousPriceInStore = existingPub?.externalProductId
    ? (
        await prisma.productPublication.findUnique({
          where: { id: existingPub.id },
          select: { priceInStore: true },
        })
      )?.priceInStore ?? null
    : null;

  try {
    let wooId: number;
    let wooSku: string;
    let wooPermalink: string;

    if (existingPub?.externalProductId) {
      // PricEcom es fuente de verdad para precio y estado siempre. Nombre y
      // descripción solo se mandan si el usuario los editó desde PricEcom
      // (override per-publication con flag userEdited). Stock/categorías/
      // imágenes son propiedad de WooCommerce. El SKU era inmutable
      // históricamente, pero Fase 4B permite renombrarlo desde PricEcom:
      // si pp.sku divirgió de pp.externalSku, lo incluimos en el payload
      // para que el sync de reintento cierre el drift.
      const updatePayload: {
        regular_price: string;
        status: string;
        name?: string;
        description?: string;
        sku?: string;
      } = {
        regular_price: price.toFixed(2),
        status: "publish",
      };
      if (
        existingPub.commercialTitleUserEdited &&
        existingPub.commercialTitle
      ) {
        updatePayload.name = existingPub.commercialTitle;
      }
      if (
        existingPub.commercialDescriptionUserEdited &&
        existingPub.commercialDescription
      ) {
        updatePayload.description = existingPub.commercialDescription;
      }
      // Drift de SKU: pp.sku es el canónico de PricEcom, externalSku es el
      // snapshot de la tienda. Si difieren, hubo un renombre que aún no se
      // aplicó (típicamente porque el endpoint de Fase 4B tuvo error
      // transitorio y marcó pendingSync). Empujamos el sku nuevo.
      if (
        existingPub.sku &&
        existingPub.externalSku &&
        existingPub.sku !== existingPub.externalSku
      ) {
        // Guard 3 (Fase 4B): antes de pushear el sku renombrado, verificar
        // que no exista en Woo con OTRO producto. Si existe, sacar de la cola
        // (no es transitorio) y devolver error específico. excludeWooProductId
        // es el wooId de ESTA publication — no contar al propio producto.
        const wooGuard = await assertSkuNotInWoo(
          client,
          existingPub.sku,
          parseInt(existingPub.externalProductId, 10)
        );
        if (!wooGuard.ok) {
          await prisma.productPublication.update({
            where: { id: existingPub.id },
            data: {
              syncStatus: "ERROR_SKU_CONFLICT",
              pendingSync: false,
              syncError: `El SKU "${existingPub.sku}" ya existe en WooCommerce con otro producto (${wooGuard.conflict.name}, wooId=${wooGuard.conflict.id}).`,
            },
          });
          return {
            success: false,
            error: `SKU conflict in Woo: "${existingPub.sku}" ya existe con otro producto (wooId=${wooGuard.conflict.id}, "${wooGuard.conflict.name}").`,
          };
        }
        updatePayload.sku = existingPub.sku;
      }
      const updated = await client.updateProduct(
        parseInt(existingPub.externalProductId, 10),
        updatePayload
      );
      wooId = updated.id;
      wooSku = updated.sku;
      wooPermalink = updated.permalink;
    } else {
      // CREATE: primera publicación, sí mandamos todo para sembrar la ficha
      // en la tienda. Una vez creada, los updates posteriores son sólo
      // precio + estado.
      //
      // Guard 3 (Fase 4B): el SKU lazy generado podría existir en Woo si el
      // cliente cargó manualmente un producto con ese SKU. Bloqueamos el
      // create con un syncStatus distinguible para sacar la pub de la cola
      // (existingPub puede ser null en CREATE: si lo es, no hay pub donde
      // grabar el conflicto — caso "Publicar por primera vez desde el
      // catálogo", solo devolvemos error).
      const wooGuard = await assertSkuNotInWoo(client, sku, null);
      if (!wooGuard.ok) {
        if (existingPub?.id) {
          await prisma.productPublication.update({
            where: { id: existingPub.id },
            data: {
              syncStatus: "ERROR_SKU_CONFLICT",
              pendingSync: false,
              syncError: `El SKU "${sku}" ya existe en WooCommerce con otro producto (${wooGuard.conflict.name}, wooId=${wooGuard.conflict.id}).`,
            },
          });
        }
        return {
          success: false,
          error: `SKU conflict in Woo: "${sku}" ya existe con otro producto (wooId=${wooGuard.conflict.id}, "${wooGuard.conflict.name}"). Asignale otro SKU comercial desde el drawer o resolvé el duplicado en Woo.`,
        };
      }

      const created = await client.createProduct({
        name: product.commercialTitle ?? product.supplierName,
        sku,
        regular_price: price.toFixed(2),
        status: "publish",
        description: product.commercialDescription ?? undefined,
        ...(stockQty != null
          ? { stock_quantity: stockQty, manage_stock: true }
          : {}),
        ...(wooCategories.length > 0 ? { categories: wooCategories } : {}),
      });
      wooId = created.id;
      wooSku = created.sku;
      wooPermalink = created.permalink;
    }

    await prisma.productPublication.upsert({
      where: { catalogProductId_storeId: { catalogProductId, storeId } },
      create: {
        catalogProductId,
        storeId,
        // SKU comercial generado lazy (o reusado si ya existía en updates).
        // En create se persiste con el resto; en update no se toca (es
        // inmutable una vez asignado).
        sku,
        externalProductId: String(wooId),
        externalSku: wooSku,
        externalStatus: "publish",
        externalUrl: wooPermalink,
        status: "ACTIVE",
        syncStatus: "SYNCED",
        priceInStore: price,
        lastPushedPrice: price, // D2 2B: baseline de autoridad = precio pusheado (= regular_price)
        pendingSync: false,
        publishedAt: new Date(),
        lastSyncedAt: new Date(),
        lastSyncAt: new Date(),
        syncError: null,
        // Seed: la primera vez que publicamos guardamos los textos que
        // mandamos a Woo como referencia, con userEdited=false (default).
        // Después un pull desde Woo o una edición del drawer flipean el flag.
        commercialTitle: product.commercialTitle ?? product.supplierName,
        commercialDescription: product.commercialDescription ?? null,
      },
      update: {
        externalProductId: String(wooId),
        externalSku: wooSku,
        externalStatus: "publish",
        externalUrl: wooPermalink,
        status: "ACTIVE",
        syncStatus: "SYNCED",
        priceInStore: price,
        lastPushedPrice: price, // D2 2B
        pendingSync: false,
        lastSyncedAt: new Date(),
        lastSyncAt: new Date(),
        syncError: null,
      },
    });

    await prisma.catalogProduct.update({
      where: { id: catalogProductId },
      data: { internalStatus: "PUBLISHED" },
    });

    const finalPub = await prisma.productPublication.findUnique({
      where: { catalogProductId_storeId: { catalogProductId, storeId } },
      select: { id: true },
    });

    // Log diferido del SKU_ASSIGNED para el CREATE path: el sku recién quedó
    // persistido en el upsert.create de arriba. Si el push hubiera fallado no
    // llegaríamos acá (catch absorbe), así que el log refleja realidad.
    if (skuJustAssignedDeferred) {
      await logInfo({
        source: "SYNC",
        type: "SKU_ASSIGNED",
        title: `SKU comercial asignado: ${sku}`,
        productId: catalogProductId,
        publicationId: finalPub?.id,
        storeId,
        metadata: {
          sku,
          providerId: product.providerId,
          catalogProductId,
        },
      });
    }

    if (existingPub?.externalProductId) {
      await logInfo({
        source: "SYNC",
        type: "WOO_SYNC_SUCCESS",
        title: `Precio sincronizado — SKU ${sku}`,
        productId: catalogProductId,
        publicationId: finalPub?.id,
        storeId,
        metadata: {
          wooId,
          sku,
          previousPrice: previousPriceInStore,
          newPrice: price,
        },
      });
    } else {
      await logInfo({
        source: "WOOCOMMERCE",
        type: "WOO_PRODUCT_CREATED",
        title: `Producto creado en WooCommerce — SKU ${sku}`,
        productId: catalogProductId,
        publicationId: finalPub?.id,
        storeId,
        metadata: { wooId, sku, price },
      });
    }

    return { success: true, externalProductId: wooId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await logError({
      source: "WOOCOMMERCE",
      type: "WOO_SYNC_ERROR",
      title: `Error al sincronizar SKU ${sku}`,
      description: message,
      productId: catalogProductId,
      publicationId: existingPub?.id,
      storeId,
      metadata: { error: message },
    });
    if (existingPub?.id) {
      const { syncStatus, pendingSync } = syncFieldsForWooError(err);
      await prisma.productPublication.update({
        where: { id: existingPub.id },
        data: {
          syncStatus,
          syncError: message,
          pendingSync,
        },
      });
    }
    return { success: false, error: message };
  }
}

export async function pauseProductInWoo(
  prisma: PrismaClient,
  client: WooCommerceClient,
  storeId: string,
  catalogProductId: string
): Promise<PublishResult> {
  const pub = await prisma.productPublication.findUnique({
    where: { catalogProductId_storeId: { catalogProductId, storeId } },
    select: { id: true, externalProductId: true },
  });

  // Si no está publicado en WooCommerce, solo actualizamos el estado interno.
  if (!pub?.externalProductId) {
    const prev = await prisma.catalogProduct.findUnique({
      where: { id: catalogProductId },
      select: { internalStatus: true },
    });
    await prisma.catalogProduct.update({
      where: { id: catalogProductId },
      data: { internalStatus: "PAUSED" },
    });
    if (prev && prev.internalStatus !== "PAUSED") {
      await logInfo({
        source: "SYNC",
        type: "PRODUCT_PAUSED_WITHOUT_WOO",
        title: "Producto pausado (sin presencia en WooCommerce)",
        productId: catalogProductId,
        storeId,
        metadata: {
          previousStatus: prev.internalStatus,
          newStatus: "PAUSED",
          reason: pub ? "no_external_product_id" : "no_publication",
        },
      });
    }
    return { success: true };
  }

  try {
    await client.updateProductStatus(
      parseInt(pub.externalProductId, 10),
      "draft"
    );
    await prisma.productPublication.update({
      where: { id: pub.id },
      data: {
        externalStatus: "draft",
        status: "PAUSED",
        syncStatus: "SYNCED",
        pendingSync: false,
        pausedAt: new Date(),
        lastSyncedAt: new Date(),
        lastSyncAt: new Date(),
        syncError: null,
      },
    });
    await prisma.catalogProduct.update({
      where: { id: catalogProductId },
      data: { internalStatus: "PAUSED" },
    });
    await logInfo({
      source: "SYNC",
      type: "WOO_PRODUCT_PAUSED",
      title: "Producto pausado en WooCommerce",
      productId: catalogProductId,
      publicationId: pub.id,
      storeId,
      metadata: { externalProductId: pub.externalProductId },
    });
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // 1A.2-ab: clasificar el fallo (recoverable/ambiguous → PENDING_SYNC;
    // terminal/unknown → ERROR + pendingSync=false). NO tocar pp.status.
    const { syncStatus, pendingSync } = syncFieldsForWooError(err);
    await prisma.productPublication.update({
      where: { id: pub.id },
      data: {
        syncStatus,
        syncError: message,
        pendingSync,
      },
    });
    await logError({
      source: "WOOCOMMERCE",
      type: "WOO_SYNC_ERROR",
      title: "Error al pausar en WooCommerce",
      description: message,
      productId: catalogProductId,
      publicationId: pub.id,
      storeId,
      metadata: { error: message, externalProductId: pub.externalProductId },
    });
    return { success: false, error: message };
  }
}
