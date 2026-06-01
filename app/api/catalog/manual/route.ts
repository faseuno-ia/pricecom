// POST /api/catalog/manual — alta one-off de un CatalogProduct sin pasar por el
// scraper. Setea sourceType=MANUAL y respeta la lógica de publicationSku
// (deriva del imageFilenamePrefix del proveedor si no viene en el body).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { buildPublicationSku } from "@/lib/catalog/publication-sku";
import { findCollidingSkuInPricEcom } from "@/lib/catalog/sku-guards";

const bodySchema = z.object({
  providerId: z.string().min(1),
  sku: z.string().min(1, "SKU del proveedor requerido"),
  publicationSku: z.string().nullable().optional(),
  name: z.string().min(1, "Nombre requerido"),
  description: z.string().nullable().optional(),
  wholesalePrice: z.number().nullable().optional(),
  stock: z.string().nullable().optional(),
  assignedCategoryId: z.string().nullable().optional(),
  manualMargin: z.number().nullable().optional(),
  finalPrice: z.number().nullable().optional(),
  notes: z.string().nullable().optional(),
  manualSourceNote: z.string().nullable().optional(),
  imageUrl: z.string().nullable().optional(),
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
  const data = parsed.data;

  // Verificar ownership del proveedor.
  const provider = await prisma.provider.findFirst({
    where: { id: data.providerId, userId: session.user.id },
    include: { scraperConfig: { select: { imageFilenamePrefix: true } } },
  });
  if (!provider) {
    return NextResponse.json(
      { error: "Proveedor no encontrado o sin permiso" },
      { status: 404 }
    );
  }

  // publicationSku: el del body si vino, si no derivar con el prefijo del proveedor.
  const publicationSku =
    data.publicationSku?.trim() ||
    buildPublicationSku(provider.scraperConfig?.imageFilenamePrefix, data.sku);

  // Verificar duplicado por (userId, providerId, sku) — clave de identidad del
  // producto en el proveedor (no del SKU comercial).
  const existing = await prisma.catalogProduct.findFirst({
    where: {
      userId: session.user.id,
      providerId: data.providerId,
      sku: data.sku,
    },
    select: { id: true },
  });
  if (existing) {
    return NextResponse.json(
      { error: "Ya existe un producto con ese SKU para este proveedor" },
      { status: 409 }
    );
  }

  // Fase 4F guard: colisión del SKU comercial (publicationSku) contra el resto
  // del catálogo. Si lo dejamos pasar, terminamos con dos CPs distintos
  // apuntando al mismo SKU comercial — el patrón TP-00658 original.
  if (publicationSku) {
    const collision = await findCollidingSkuInPricEcom(
      prisma,
      session.user.id,
      publicationSku
    );
    if (collision) {
      return NextResponse.json(
        {
          error: `El SKU comercial "${publicationSku}" ya pertenece a otro producto (${collision.supplierName.slice(0, 60)}). Asignale otro SKU comercial o dejá el campo vacío para derivarlo del proveedor.`,
          conflictingCatalogProductId: collision.catalogProductId,
        },
        { status: 409 }
      );
    }
  }

  const imageUrl = data.imageUrl?.trim() || null;

  const created = await prisma.catalogProduct.create({
    data: {
      userId: session.user.id,
      providerId: data.providerId,
      sku: data.sku,
      publicationSku,
      supplierName: data.name,
      supplierDescription: data.description ?? null,
      wholesalePrice: data.wholesalePrice ?? null,
      stock: data.stock ?? null,
      imageUrl, // mantenemos en el flat field como referencia
      assignedCategoryId: data.assignedCategoryId ?? null,
      manualMargin: data.manualMargin ?? null,
      finalPrice: data.finalPrice ?? null,
      notes: data.notes ?? null,
      manualSourceNote: data.manualSourceNote ?? null,
      sourceType: "MANUAL",
      supplierStatus: "ACTIVE",
      internalStatus: "NOT_PUBLISHED",
      lastSeenAt: new Date(),
    },
  });

  if (imageUrl) {
    await prisma.catalogProductImage.create({
      data: {
        catalogProductId: created.id,
        url: imageUrl,
        position: 0,
        isPrimary: true,
        source: "USER",
      },
    });
  }

  return NextResponse.json({ id: created.id }, { status: 201 });
}
