import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { InternalPublicationStatus } from "@prisma/client";
import { z } from "zod";
import { WooCommerceClient } from "@/lib/integrations/woocommerce/client";
import {
  publishProductToWoo,
  pauseProductInWoo,
} from "@/lib/integrations/woocommerce/publication-service";
import type { PricingRuleForCalc } from "@/lib/pricing/pricing-engine";
import { markPublicationsDrift } from "@/lib/catalog/mark-publications-drift";
import { logInfo } from "@/lib/events/event-log";

// Acciones de usuario — NUNCA tocan supplierStatus (ese estado lo maneja
// exclusivamente el worker / importador en base a presencia del producto en
// el catálogo del proveedor).
const STATUS_ACTIONS = ["ignore", "restore", "prepare", "pause"] as const;
const ACTIONS = [
  ...STATUS_ACTIONS,
  "clear_margin",
  "clear_price",
  "copy_own_stock",
  "remove_own_stock",
  "publish",
  "mark_no_stock",
  "set_cost",
] as const;

const bodySchema = z.object({
  productIds: z.array(z.string()).min(1).max(1000),
  action: z.enum(ACTIONS),
  // Solo se lee para action=set_cost. Precio mayorista positivo.
  wholesalePrice: z.number().positive().optional(),
});

const actionMap: Record<
  (typeof STATUS_ACTIONS)[number],
  InternalPublicationStatus
> = {
  ignore: "IGNORED",
  restore: "NOT_PUBLISHED",
  prepare: "PREPARED",
  pause: "PAUSED",
};

export async function POST(req: NextRequest) {
  const session = await requireSession();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validación falló", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const { productIds, action } = parsed.data;

  if (action === "clear_margin") {
    const owned = await prisma.catalogProduct.findMany({
      where: { id: { in: productIds }, userId: session.user.id },
      select: { id: true },
    });
    const ownedIds = owned.map((p) => p.id);
    const result = await prisma.catalogProduct.updateMany({
      where: { id: { in: ownedIds } },
      data: { manualMargin: null },
    });
    // El precio cambia → drift en las publications ACTIVE.
    await markPublicationsDrift(prisma, ownedIds);
    return NextResponse.json({ updated: result.count });
  }

  // clear_price: limpia el override de finalPrice; el motor de pricing vuelve
  // a calcular el precio a partir de la regla aplicable.
  if (action === "clear_price") {
    const owned = await prisma.catalogProduct.findMany({
      where: { id: { in: productIds }, userId: session.user.id },
      select: { id: true },
    });
    const ownedIds = owned.map((p) => p.id);
    const result = await prisma.catalogProduct.updateMany({
      where: { id: { in: ownedIds } },
      data: { finalPrice: null },
    });
    await markPublicationsDrift(prisma, ownedIds);
    return NextResponse.json({ updated: result.count });
  }

  // copy_own_stock: marca los productos como stock propio (sin duplicar).
  // A diferencia del modelo viejo, ya no se crea un CatalogProduct paralelo
  // en el provider OWN_STOCK — la marca vive sobre la misma fila.
  if (action === "copy_own_stock") {
    const owned = await prisma.catalogProduct.findMany({
      where: { id: { in: productIds }, userId: session.user.id },
      select: { id: true },
    });
    const ownedIds = owned.map((p) => p.id);
    const result = await prisma.catalogProduct.updateMany({
      where: { id: { in: ownedIds } },
      data: { stockSource: "OWN" },
    });
    await logInfo({
      source: "USER",
      type: "PRODUCT_MOVED_TO_OWN_STOCK",
      title: `${result.count} producto(s) movidos a stock propio`,
      userId: session.user.id,
      metadata: { productIds: ownedIds, count: result.count },
    });
    return NextResponse.json({ updated: result.count });
  }

  // publish: empuja los productos a la tienda WooCommerce conectada. Crea o
  // actualiza el producto remoto, sincroniza precio/stock/categorías y deja
  // ProductPublication.status = ACTIVE + CatalogProduct.internalStatus =
  // PUBLISHED. Los errores se acumulan por producto sin abortar el batch.
  if (action === "publish") {
    const store = await prisma.store.findFirst({
      where: { userId: session.user.id },
      include: { integrations: { orderBy: { createdAt: "desc" }, take: 1 } },
    });
    if (!store) {
      return NextResponse.json(
        { error: "Sin tienda conectada" },
        { status: 400 }
      );
    }
    if (store.platform !== "WOOCOMMERCE") {
      return NextResponse.json(
        { error: "Solo WooCommerce soportado por ahora" },
        { status: 400 }
      );
    }
    const integration = store.integrations[0];
    if (!integration) {
      return NextResponse.json(
        { error: "Sin integración configurada" },
        { status: 400 }
      );
    }

    let client: WooCommerceClient;
    try {
      client = WooCommerceClient.fromIntegration({
        storeUrl: store.url,
        consumerKeyEncrypted: integration.consumerKeyEncrypted,
        consumerSecretEncrypted: integration.consumerSecretEncrypted,
      });
    } catch (err) {
      return NextResponse.json(
        {
          error:
            err instanceof Error ? err.message : "Error de credenciales",
        },
        { status: 400 }
      );
    }

    const rules = (await prisma.pricingRule.findMany({
      where: { userId: session.user.id, isActive: true },
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

    // Filtramos por userId acá para evitar publicar productos ajenos por
    // un id leakeado en el body.
    const owned = await prisma.catalogProduct.findMany({
      where: { id: { in: productIds }, userId: session.user.id },
      select: { id: true },
    });
    const ownedIds = owned.map((p) => p.id);

    let published = 0;
    const errors: { id: string; error: string }[] = [];

    for (const id of ownedIds) {
      const result = await publishProductToWoo(
        prisma,
        client,
        store.id,
        id,
        rules
      );
      if (result.success) published++;
      else errors.push({ id, error: result.error ?? "Error desconocido" });
    }

    if (published > 0) {
      await logInfo({
        source: "USER",
        type: "USER_PUBLISHED_PRODUCT",
        title: `${published} producto(s) publicados manualmente`,
        userId: session.user.id,
        storeId: store.id,
        metadata: {
          count: published,
          total: ownedIds.length,
          errors: errors.length,
          productIds: ownedIds,
        },
      });
    }

    return NextResponse.json({
      published,
      errors,
      total: ownedIds.length,
    });
  }

  // mark_no_stock: equivalente "manual" del auto-pause del worker, pero
  // disparado por el usuario. Solo aplica a productos de proveedores
  // no-SCRAPER (MANUAL / IMPORTED / OWN_STOCK) donde el worker nunca va a
  // detectar la baja por sí solo. Marca supplierStatus=SUPPLIER_REMOVED y
  // pausedBySystem=true para que el visual status muestre "Sin stock" y se
  // empuje a draft en Woo en el mismo request.
  if (action === "mark_no_stock") {
    const products = await prisma.catalogProduct.findMany({
      where: { id: { in: productIds }, userId: session.user.id },
      select: {
        id: true,
        provider: { select: { providerType: true } },
      },
    });
    const eligibleIds = products
      .filter((p) => p.provider.providerType !== "SCRAPER")
      .map((p) => p.id);
    const skipped = products.length - eligibleIds.length;

    if (eligibleIds.length === 0) {
      return NextResponse.json({ updated: 0, skipped, wooPaused: 0, wooErrors: 0 });
    }

    await prisma.catalogProduct.updateMany({
      where: { id: { in: eligibleIds } },
      data: {
        supplierStatus: "SUPPLIER_REMOVED",
        pausedBySystem: true,
      },
    });

    // Push inmediato a Woo: misma lógica que pause/ignore. Cargamos
    // publications ACTIVE y cacheamos un client por store.
    const publications = await prisma.productPublication.findMany({
      where: { catalogProductId: { in: eligibleIds }, status: "ACTIVE" },
      select: { id: true, catalogProductId: true, storeId: true },
    });

    let wooPaused = 0;
    let wooErrors = 0;
    if (publications.length > 0) {
      const clientByStore = new Map<string, WooCommerceClient>();
      const distinctStoreIds = Array.from(
        new Set(publications.map((p) => p.storeId))
      );
      for (const sid of distinctStoreIds) {
        const store = await prisma.store.findFirst({
          where: { id: sid, userId: session.user.id },
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
          // Sin credenciales válidas: la publication queda PENDING_SYNC y
          // reaparecerá en el próximo retry desde Mi Tienda.
        }
      }
      for (const pub of publications) {
        const client = clientByStore.get(pub.storeId);
        if (!client) continue;
        const res = await pauseProductInWoo(
          prisma,
          client,
          pub.storeId,
          pub.catalogProductId
        );
        if (res.success) wooPaused++;
        else wooErrors++;
      }
    }

    await logInfo({
      source: "USER",
      type: "PRODUCT_MARKED_NO_STOCK",
      title: `${eligibleIds.length} producto(s) marcados sin stock`,
      userId: session.user.id,
      metadata: {
        count: eligibleIds.length,
        skipped,
        productIds: eligibleIds,
      },
    });

    return NextResponse.json({
      updated: eligibleIds.length,
      skipped,
      wooPaused,
      wooErrors,
    });
  }

  // set_cost: setea wholesalePrice en bulk. Solo aplica a productos de
  // proveedores no-SCRAPER — el costo de los scrapeados lo maneja el worker.
  // El precio de venta calculado puede cambiar → markPublicationsDrift se
  // encarga (solo marca OUTDATED si efectivamente cambió respecto al precio
  // en la tienda).
  if (action === "set_cost") {
    const wholesalePrice = parsed.data.wholesalePrice;
    if (wholesalePrice === undefined) {
      return NextResponse.json(
        { error: "set_cost requiere wholesalePrice > 0" },
        { status: 400 }
      );
    }

    const products = await prisma.catalogProduct.findMany({
      where: { id: { in: productIds }, userId: session.user.id },
      select: {
        id: true,
        provider: { select: { providerType: true } },
      },
    });
    const eligibleIds = products
      .filter((p) => p.provider.providerType !== "SCRAPER")
      .map((p) => p.id);
    const skipped = products.length - eligibleIds.length;

    if (eligibleIds.length === 0) {
      return NextResponse.json({ updated: 0, skipped });
    }

    const updateResult = await prisma.catalogProduct.updateMany({
      where: { id: { in: eligibleIds } },
      data: { wholesalePrice },
    });

    await markPublicationsDrift(prisma, eligibleIds);

    await logInfo({
      source: "USER",
      type: "PRODUCT_COST_UPDATED",
      title: `Costo actualizado en ${updateResult.count} producto(s)`,
      userId: session.user.id,
      metadata: {
        count: updateResult.count,
        skipped,
        wholesalePrice,
        productIds: eligibleIds,
      },
    });

    return NextResponse.json({ updated: updateResult.count, skipped });
  }

  // remove_own_stock: revierte a stockSource=SUPPLIER. Si el producto está
  // PUBLISHED|PREPARED y el proveedor ya lo dio de baja (SUPPLIER_REMOVED),
  // lo auto-pausamos porque sin proveedor y sin stock propio no hay manera
  // de abastecerlo.
  if (action === "remove_own_stock") {
    const owned = await prisma.catalogProduct.findMany({
      where: { id: { in: productIds }, userId: session.user.id },
      select: { id: true },
    });
    const ownedIds = owned.map((p) => p.id);
    const [revert, autoPause] = await prisma.$transaction([
      prisma.catalogProduct.updateMany({
        where: { id: { in: ownedIds } },
        data: { stockSource: "SUPPLIER" },
      }),
      prisma.catalogProduct.updateMany({
        where: {
          id: { in: ownedIds },
          supplierStatus: "SUPPLIER_REMOVED",
          internalStatus: { in: ["PUBLISHED", "PREPARED"] },
        },
        data: { internalStatus: "PAUSED" },
      }),
    ]);
    await logInfo({
      source: "USER",
      type: "PRODUCT_REMOVED_FROM_OWN_STOCK",
      title: `${revert.count} producto(s) removidos de stock propio`,
      userId: session.user.id,
      metadata: {
        productIds: ownedIds,
        count: revert.count,
        autoPaused: autoPause.count,
      },
    });
    return NextResponse.json({
      updated: revert.count,
      autoPaused: autoPause.count,
    });
  }

  const internalStatus = actionMap[action];

  const owned = await prisma.catalogProduct.findMany({
    where: { id: { in: productIds }, userId: session.user.id },
    select: { id: true },
  });
  const ownedIds = owned.map((p) => p.id);

  const result = await prisma.catalogProduct.updateMany({
    where: { id: { in: ownedIds } },
    data: {
      internalStatus,
      // Cualquier cambio de estado manual borra la marca de pausa automática:
      // si el worker la había puesto y el usuario actúa (pausa/restaura/etc.),
      // pasa a ser una decisión humana y el worker ya no debe reactivar solo.
      pausedBySystem: false,
    },
  });

  // PAUSE / IGNORE: push inmediato a WooCommerce — bajamos a draft en la
  // tienda en el mismo request, sin esperar que el usuario corra
  // "Sincronizar pendientes". Esto reemplaza el viejo markPublicationsDrift
  // (que solo funcionaba bien cuando había drift de precio). Si Woo falla,
  // pauseProductInWoo loguea WOO_SYNC_ERROR y marca la publication con
  // syncStatus=ERROR + pendingSync=true para que quede capturada por el
  // próximo retry desde la UI.
  let wooPaused = 0;
  let wooErrors = 0;
  if (action === "pause" || action === "ignore") {
    const publications = await prisma.productPublication.findMany({
      where: { catalogProductId: { in: ownedIds }, status: "ACTIVE" },
      select: { id: true, catalogProductId: true, storeId: true },
    });

    if (publications.length > 0) {
      // Las publications de un mismo usuario suelen pertenecer a la misma
      // store. Por las dudas resolvemos un client por storeId (cache).
      const clientByStore = new Map<string, WooCommerceClient>();
      const distinctStoreIds = Array.from(
        new Set(publications.map((p) => p.storeId))
      );
      for (const sid of distinctStoreIds) {
        const store = await prisma.store.findFirst({
          where: { id: sid, userId: session.user.id },
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
          // Sin credenciales válidas, no podemos pushear. La publication se
          // quedó con catalogProduct.internalStatus=PAUSED y reaparecerá en
          // el próximo sync como drift.
        }
      }

      for (const pub of publications) {
        const client = clientByStore.get(pub.storeId);
        if (!client) continue;
        const res = await pauseProductInWoo(
          prisma,
          client,
          pub.storeId,
          pub.catalogProductId
        );
        if (res.success) wooPaused++;
        else wooErrors++;
      }
    }
  }

  // Audit trail por acción de usuario.
  if (action === "pause" && result.count > 0) {
    await logInfo({
      source: "USER",
      type: "USER_PAUSED_PRODUCT",
      title: `${result.count} producto(s) pausados manualmente`,
      userId: session.user.id,
      metadata: { count: result.count, productIds: ownedIds },
    });
  } else if (action === "ignore" && result.count > 0) {
    await logInfo({
      source: "USER",
      type: "USER_IGNORED_PRODUCT",
      title: `${result.count} producto(s) ignorados`,
      userId: session.user.id,
      metadata: { count: result.count, productIds: ownedIds },
    });
  } else if (action === "restore" && result.count > 0) {
    await logInfo({
      source: "USER",
      type: "USER_RESTORED_PRODUCT",
      title: `${result.count} producto(s) restaurados`,
      userId: session.user.id,
      metadata: { count: result.count, productIds: ownedIds },
    });
  }

  return NextResponse.json({
    updated: result.count,
    ...(action === "pause" || action === "ignore"
      ? { wooPaused, wooErrors }
      : {}),
  });
}
