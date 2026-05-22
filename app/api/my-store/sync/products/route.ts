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
import type { InternalPublicationStatus } from "@prisma/client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Mapea el estado de WooCommerce al internalStatus del CatalogProduct.
// Respeta IGNORED y PAUSED del usuario — no los pisa automáticamente.
// Devuelve null cuando no hay que tocar nada (ej. trash, o status manual
// que queremos preservar).
function mapInternalStatus(
  externalStatus: string,
  currentInternal: InternalPublicationStatus
): InternalPublicationStatus | null {
  if (currentInternal === "IGNORED") return null;
  if (currentInternal === "PAUSED") return null;
  switch (externalStatus) {
    case "publish":
      return currentInternal === "PUBLISHED" ? null : "PUBLISHED";
    case "draft":
    case "private":
    case "pending":
      return currentInternal === "PREPARED" ? null : "PREPARED";
    case "trash":
    default:
      return null;
  }
}

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
  // Acumulamos los externalProductId que matchearon para barrer al final los
  // UnmatchedStoreProduct que quedaron como fantasmas (de syncs previos en los
  // que el match aún no resolvía). Sin esto, la pestaña "No vinculados" sigue
  // mostrando productos que ya están publicados.
  const matchedExternalIds: string[] = [];

  for (const woo of wooProducts) {
    const skuRaw = woo.sku?.trim() ?? "";

    // Match solo si el WooCommerce trae SKU; sin SKU no hay auto-vinculación.
    const catalogProduct = skuRaw
      ? ((await prisma.catalogProduct.findFirst({
          where: { userId: session.user.id, publicationSku: skuRaw },
          select: { id: true, internalStatus: true },
        })) ??
        (await prisma.catalogProduct.findFirst({
          where: { userId: session.user.id, sku: skuRaw },
          select: { id: true, internalStatus: true },
        })))
      : null;

    if (!catalogProduct) {
      // Persistir en UnmatchedStoreProduct. NO reseteamos `ignored`: si el
      // usuario lo marcó como ignorado, esa decisión sobrevive a las
      // re-importaciones. Solo refrescamos los datos visibles.
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
        },
      });
      unmatchedCount++;
      continue;
    }

    matched++;
    matchedExternalIds.push(String(woo.id));

    const externalStatus = woo.status;
    // Status de la publication (no confundir con internalStatus del catálogo).
    const pubStatus =
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
      select: {
        id: true,
        commercialTitleUserEdited: true,
        commercialDescriptionUserEdited: true,
      },
    });

    const wooDescription = woo.description?.trim() ? woo.description : null;

    const baseData = {
      status: pubStatus as
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
      // Override per-publication: solo pisamos los campos comerciales si el
      // usuario NO los editó desde PricEcom. Si los editó, mantenemos su
      // valor (el push a Woo se encarga de subir su versión).
      await prisma.productPublication.update({
        where: { id: existing.id },
        data: {
          ...baseData,
          ...(existing.commercialTitleUserEdited
            ? {}
            : { commercialTitle: woo.name }),
          ...(existing.commercialDescriptionUserEdited
            ? {}
            : { commercialDescription: wooDescription }),
        },
      });
      updated++;
    } else {
      // Publicación nueva: sembramos título y descripción desde Woo con los
      // flags de user-edited en false (default).
      await prisma.productPublication.create({
        data: {
          catalogProductId: catalogProduct.id,
          storeId: store.id,
          ...baseData,
          commercialTitle: woo.name,
          commercialDescription: wooDescription,
        },
      });
      created++;
    }

    // Propagar al CatalogProduct.internalStatus respetando overrides del usuario.
    const nextInternal = mapInternalStatus(
      externalStatus,
      catalogProduct.internalStatus
    );

    // WooCommerce es fuente inicial de nombre/descripción, pero si el usuario
    // los editó desde PricEcom (flag userEdited en la ProductPublication),
    // respetamos su versión. CatalogProduct refleja lo que la UI debería
    // mostrar al usuario; usamos los mismos flags de la publication para
    // decidir si pisar o no.
    await prisma.catalogProduct.update({
      where: { id: catalogProduct.id },
      data: {
        ...(existing?.commercialTitleUserEdited
          ? {}
          : { commercialTitle: woo.name }),
        ...(existing?.commercialDescriptionUserEdited
          ? {}
          : { commercialDescription: wooDescription }),
        ...(nextInternal ? { internalStatus: nextInternal } : {}),
      },
    });
  }

  // Cleanup de fantasmas: cualquier UnmatchedStoreProduct cuyo externalProductId
  // matcheó en este sync deja de ser "no vinculado". Lo marcamos ignored=true
  // para que desaparezca de la vista por defecto sin perder el registro
  // histórico (si el usuario desvincula manualmente en el futuro, lo vuelve a
  // ver con "Incluir ignorados").
  let unmatchedClearedCount = 0;
  if (matchedExternalIds.length > 0) {
    const cleared = await prisma.unmatchedStoreProduct.updateMany({
      where: {
        storeId: store.id,
        ignored: false,
        externalProductId: { in: matchedExternalIds },
      },
      data: { ignored: true },
    });
    unmatchedClearedCount = cleared.count;
  }

  return NextResponse.json({
    matched,
    created,
    updated,
    unmatchedCount,
    unmatchedCleared: unmatchedClearedCount,
    total: wooProducts.length,
  });
}

function parsePrice(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = String(raw).replace(",", ".").trim();
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}
