// POST /api/catalog/copy-to-own-stock — clona productos origen en un proveedor
// virtual "Mi stock" (providerType=OWN_STOCK) para que el cliente pueda seguir
// vendiéndolos aunque el proveedor original los dé de baja. El nuevo producto
// queda con stockSource=OWN y sourceCatalogProductId apuntando al original.
// Idempotente: si ya existe un derivado para un producto origen, se saltea.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";

const bodySchema = z.object({
  productIds: z.array(z.string()).min(1).max(500),
});

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

  // Cargar productos origen con sus imágenes; verificamos ownership en el where.
  const sourceProducts = await prisma.catalogProduct.findMany({
    where: {
      id: { in: parsed.data.productIds },
      userId: session.user.id,
    },
    include: {
      images: { orderBy: [{ isPrimary: "desc" }, { position: "asc" }] },
    },
  });

  if (sourceProducts.length === 0) {
    return NextResponse.json(
      { error: "Ningún producto encontrado o sin permiso" },
      { status: 404 }
    );
  }

  // Buscar o crear el proveedor "Mi stock" del usuario.
  let ownStockProvider = await prisma.provider.findFirst({
    where: { userId: session.user.id, providerType: "OWN_STOCK" },
  });
  if (!ownStockProvider) {
    ownStockProvider = await prisma.provider.create({
      data: {
        userId: session.user.id,
        name: "Mi stock",
        providerType: "OWN_STOCK",
        baseUrl: "",
        isActive: true,
      },
    });
  }

  let copied = 0;
  let skipped = 0;

  for (const src of sourceProducts) {
    // Idempotencia: si ya hay un derivado de este origen en OWN_STOCK, salteamos.
    const existingDerived = await prisma.catalogProduct.findFirst({
      where: {
        userId: session.user.id,
        providerId: ownStockProvider.id,
        sourceCatalogProductId: src.id,
      },
      select: { id: true },
    });
    if (existingDerived) {
      skipped++;
      continue;
    }

    // SKU del derivado: reusamos el del origen. Si por casualidad ya hay un
    // producto en OWN_STOCK con ese SKU (clave única userId+providerId+sku),
    // sufijamos con "-copy-<6cuid>" para evitar la colisión.
    const baseSku = src.sku ?? src.id;
    let skuToUse = baseSku;
    const skuClash = await prisma.catalogProduct.findFirst({
      where: {
        userId: session.user.id,
        providerId: ownStockProvider.id,
        sku: skuToUse,
      },
      select: { id: true },
    });
    if (skuClash) {
      skuToUse = `${baseSku}-copy-${Math.random().toString(36).slice(2, 8)}`;
    }

    const created = await prisma.catalogProduct.create({
      data: {
        userId: session.user.id,
        providerId: ownStockProvider.id,
        sku: skuToUse,
        publicationSku: src.publicationSku,
        supplierName: src.commercialTitle ?? src.supplierName,
        supplierDescription:
          src.commercialDescription ?? src.supplierDescription,
        wholesalePrice: src.wholesalePrice,
        imageUrl: src.imageUrl,
        lastSeenAt: new Date(),
        supplierStatus: "ACTIVE",
        internalStatus: src.internalStatus,
        stockSource: "OWN",
        sourceType: "MANUAL",
        sourceCatalogProductId: src.id,
        commercialTitle: src.commercialTitle,
        commercialDescription: src.commercialDescription,
        finalPrice: src.finalPrice,
        manualMargin: src.manualMargin,
        assignedCategoryId: src.assignedCategoryId,
        pricingRuleId: src.pricingRuleId,
        notes: src.notes,
      },
    });

    if (src.images.length > 0) {
      await prisma.catalogProductImage.createMany({
        data: src.images.map((img, idx) => ({
          catalogProductId: created.id,
          url: img.url,
          position: idx,
          isPrimary: img.isPrimary,
          source: img.source,
          altText: img.altText,
        })),
      });
    }

    copied++;
  }

  return NextResponse.json({ copied, skipped });
}
