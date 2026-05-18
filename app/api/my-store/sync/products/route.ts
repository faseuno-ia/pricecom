// POST /api/my-store/sync/products — importa productos de la tienda externa
// y crea/actualiza ProductPublication para los que matchean por SKU contra
// el catálogo. Los que no matchean quedan en `unmatched` para que el usuario
// los vincule manualmente.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import {
  WooCommerceClient,
  type WooProduct,
} from "@/lib/integrations/woocommerce/client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST() {
  const session = await requireSession();

  const store = await prisma.store.findFirst({
    where: { userId: session.user.id },
    include: { integrations: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (!store) {
    return NextResponse.json({ error: "Sin tienda conectada" }, { status: 404 });
  }
  const integration = store.integrations[0];
  if (!integration) {
    return NextResponse.json(
      { error: "Sin integración configurada" },
      { status: 400 }
    );
  }
  if (store.platform !== "WOOCOMMERCE") {
    return NextResponse.json(
      { error: "Solo WooCommerce soportado por ahora" },
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
      { error: err instanceof Error ? err.message : "Error de credenciales" },
      { status: 400 }
    );
  }

  let wooProducts: WooProduct[];
  try {
    wooProducts = await client.getAllProducts();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error de API" },
      { status: 502 }
    );
  }

  let matched = 0;
  let created = 0;
  let updated = 0;
  let unmatchedCount = 0;

  for (const woo of wooProducts) {
    const skuRaw = woo.sku?.trim() ?? "";

    // Match solo si el WooCommerce trae SKU; sin SKU no hay auto-vinculación.
    const catalogProduct = skuRaw
      ? ((await prisma.catalogProduct.findFirst({
          where: { userId: session.user.id, publicationSku: skuRaw },
          select: { id: true },
        })) ??
        (await prisma.catalogProduct.findFirst({
          where: { userId: session.user.id, sku: skuRaw },
          select: { id: true },
        })))
      : null;

    if (!catalogProduct) {
      // Persistir en UnmatchedStoreProduct. Si reaparece (estaba ignored=true),
      // reseteamos ignored a false para que vuelva a la vista de no vinculados.
      const wooCats = JSON.stringify(
        (woo.categories ?? []).map((c) => c.name)
      );
      await prisma.unmatchedStoreProduct.upsert({
        where: {
          storeId_externalProductId: {
            storeId: store.id,
            externalProductId: String(woo.id),
          },
        },
        create: {
          storeId: store.id,
          externalProductId: String(woo.id),
          externalSku: skuRaw || null,
          name: woo.name,
          price: parsePrice(woo.regular_price ?? woo.price),
          stockQuantity: woo.stock_quantity ?? null,
          imageUrl: woo.images?.[0]?.src ?? null,
          categories: wooCats,
          permalink: woo.permalink,
        },
        update: {
          externalSku: skuRaw || null,
          name: woo.name,
          price: parsePrice(woo.regular_price ?? woo.price),
          stockQuantity: woo.stock_quantity ?? null,
          imageUrl: woo.images?.[0]?.src ?? null,
          categories: wooCats,
          permalink: woo.permalink,
          ignored: false,
        },
      });
      unmatchedCount++;
      continue;
    }

    matched++;

    const externalStatus = woo.status;
    const internalStatus =
      externalStatus === "publish"
        ? "ACTIVE"
        : externalStatus === "draft"
          ? "DRAFT"
          : externalStatus === "trash"
            ? "REMOVED"
            : "PAUSED";
    const priceInStore = parsePrice(woo.regular_price ?? woo.price);
    const categoryInStore = woo.categories?.[0]?.name ?? null;

    const existing = await prisma.productPublication.findUnique({
      where: {
        catalogProductId_storeId: {
          catalogProductId: catalogProduct.id,
          storeId: store.id,
        },
      },
      select: { id: true },
    });

    const data = {
      status: internalStatus as
        | "ACTIVE"
        | "DRAFT"
        | "PAUSED"
        | "REMOVED"
        | "ERROR",
      externalProductId: String(woo.id),
      externalSku: skuRaw,
      externalStatus,
      externalUrl: woo.permalink,
      priceInStore,
      stockInStore: woo.stock_quantity ?? null,
      categoryInStore,
      lastSyncedAt: new Date(),
      lastSyncAt: new Date(),
      pendingSync: false,
      syncStatus: "SYNCED" as const,
      syncError: null,
    };

    if (existing) {
      await prisma.productPublication.update({
        where: { id: existing.id },
        data,
      });
      updated++;
    } else {
      await prisma.productPublication.create({
        data: {
          catalogProductId: catalogProduct.id,
          storeId: store.id,
          ...data,
        },
      });
      created++;
    }
  }

  return NextResponse.json({
    matched,
    created,
    updated,
    unmatchedCount,
    total: wooProducts.length,
  });
}

function parsePrice(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = String(raw).replace(",", ".").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
