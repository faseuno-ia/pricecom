// POST /api/my-store/unmatched/[id]/create-catalog — crea un CatalogProduct
// nuevo (sourceType=MANUAL, stockSource=OWN) a partir del producto detectado
// en WooCommerce y lo vincula como ProductPublication. Útil cuando el cliente
// quiere conservar el producto sin tener un proveedor para él.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await requireSession();

  const unmatched = await prisma.unmatchedStoreProduct.findFirst({
    where: { id: params.id, store: { userId: session.user.id } },
  });
  if (!unmatched) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }

  // Provider virtual OWN_STOCK (compartido con copy-to-own-stock).
  let ownStock = await prisma.provider.findFirst({
    where: { userId: session.user.id, providerType: "OWN_STOCK" },
  });
  if (!ownStock) {
    ownStock = await prisma.provider.create({
      data: {
        userId: session.user.id,
        name: "Mi stock",
        providerType: "OWN_STOCK",
        baseUrl: "",
        isActive: true,
      },
    });
  }

  // SKU para el CatalogProduct: usa externalSku si vino, si no inventa uno con
  // el externalProductId. Si colisiona con uno existente, sufija.
  const baseSku =
    unmatched.externalSku ?? `WOO-${unmatched.externalProductId}`;
  let sku = baseSku;
  const existing = await prisma.catalogProduct.findFirst({
    where: {
      userId: session.user.id,
      providerId: ownStock.id,
      sku,
    },
    select: { id: true },
  });
  if (existing) {
    sku = `${baseSku}-${Math.random().toString(36).slice(2, 6)}`;
  }

  const created = await prisma.catalogProduct.create({
    data: {
      userId: session.user.id,
      providerId: ownStock.id,
      sku,
      publicationSku: unmatched.externalSku ?? sku,
      supplierName: unmatched.name,
      finalPrice: unmatched.price,
      stock:
        unmatched.stockQuantity != null
          ? String(unmatched.stockQuantity)
          : null,
      imageUrl: unmatched.imageUrl,
      lastSeenAt: new Date(),
      supplierStatus: "ACTIVE",
      internalStatus: "PREPARED",
      stockSource: "OWN",
      sourceType: "MANUAL",
      manualSourceNote: `Creado desde WooCommerce (externalId=${unmatched.externalProductId})`,
    },
  });

  if (unmatched.imageUrl) {
    await prisma.catalogProductImage.create({
      data: {
        catalogProductId: created.id,
        url: unmatched.imageUrl,
        position: 0,
        isPrimary: true,
        source: "USER",
      },
    });
  }

  const publication = await prisma.productPublication.create({
    data: {
      catalogProductId: created.id,
      storeId: unmatched.storeId,
      status: "ACTIVE",
      syncStatus: "SYNCED",
      externalProductId: unmatched.externalProductId,
      externalSku: unmatched.externalSku,
      externalUrl: unmatched.permalink,
      priceInStore: unmatched.price,
      stockInStore: unmatched.stockQuantity,
      lastSyncedAt: new Date(),
      lastSyncAt: new Date(),
    },
  });

  await prisma.unmatchedStoreProduct.update({
    where: { id: unmatched.id },
    data: { resolved: true },
  });

  return NextResponse.json({
    catalogProductId: created.id,
    publicationId: publication.id,
  });
}
