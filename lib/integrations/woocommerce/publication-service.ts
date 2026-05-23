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

export interface PublishResult {
  success: boolean;
  externalProductId?: number;
  error?: string;
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
      provider: { select: { listDiscountPercent: true } },
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

  const sku = product.publicationSku ?? product.sku;
  if (!sku) {
    return { success: false, error: "Producto sin SKU" };
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
      externalProductId: true,
      commercialTitle: true,
      commercialTitleUserEdited: true,
      commercialDescription: true,
      commercialDescriptionUserEdited: true,
    },
  });

  try {
    let wooId: number;
    let wooSku: string;
    let wooPermalink: string;

    if (existingPub?.externalProductId) {
      // PricEcom es fuente de verdad para precio y estado siempre. Nombre y
      // descripción solo se mandan si el usuario los editó desde PricEcom
      // (override per-publication con flag userEdited). El resto de campos
      // (SKU, stock, categorías, imágenes) son propiedad de WooCommerce.
      const updatePayload: {
        regular_price: string;
        status: string;
        name?: string;
        description?: string;
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
        externalProductId: String(wooId),
        externalSku: wooSku,
        externalStatus: "publish",
        externalUrl: wooPermalink,
        status: "ACTIVE",
        syncStatus: "SYNCED",
        priceInStore: price,
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

    return { success: true, externalProductId: wooId };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (existingPub?.id) {
      await prisma.productPublication.update({
        where: { id: existingPub.id },
        data: {
          syncStatus: "ERROR",
          status: "ERROR",
          syncError: message,
          pendingSync: true,
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
    await prisma.catalogProduct.update({
      where: { id: catalogProductId },
      data: { internalStatus: "PAUSED" },
    });
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
    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await prisma.productPublication.update({
      where: { id: pub.id },
      data: {
        syncStatus: "ERROR",
        syncError: message,
        pendingSync: true,
      },
    });
    return { success: false, error: message };
  }
}
