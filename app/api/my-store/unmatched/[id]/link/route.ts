// POST /api/my-store/unmatched/[id]/link — vincula manualmente un producto
// WooCommerce sin match a un CatalogProduct existente.
//
// Body: { catalogProductId: string }
// Crea ProductPublication con syncStatus=READY (el sync engine después decide
// si hay drift y la marca como PENDING_SYNC). Marca el unmatched como ignored.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";

const bodySchema = z.object({ catalogProductId: z.string().min(1) });

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
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

  // Ownership: tanto el unmatched como el catalogProduct deben pertenecer al
  // usuario logueado (vía store y userId respectivamente).
  const unmatched = await prisma.unmatchedStoreProduct.findFirst({
    where: { id: params.id, store: { userId: session.user.id } },
    include: { store: { select: { id: true } } },
  });
  if (!unmatched) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }

  const catalogProduct = await prisma.catalogProduct.findFirst({
    where: {
      id: parsed.data.catalogProductId,
      userId: session.user.id,
    },
    select: { id: true },
  });
  if (!catalogProduct) {
    return NextResponse.json(
      { error: "CatalogProduct no encontrado" },
      { status: 404 }
    );
  }

  // Si ya hay una publication para ese par (catalogProduct, store), la
  // refrescamos en vez de duplicar.
  const publication = await prisma.productPublication.upsert({
    where: {
      catalogProductId_storeId: {
        catalogProductId: catalogProduct.id,
        storeId: unmatched.storeId,
      },
    },
    create: {
      catalogProductId: catalogProduct.id,
      storeId: unmatched.storeId,
      externalProductId: unmatched.externalProductId,
      externalSku: unmatched.externalSku,
      externalUrl: unmatched.permalink,
      priceInStore: unmatched.price,
      stockInStore: unmatched.stockQuantity,
      status: "DRAFT",
      syncStatus: "READY",
      pendingSync: false,
    },
    update: {
      externalProductId: unmatched.externalProductId,
      externalSku: unmatched.externalSku,
      externalUrl: unmatched.permalink,
      priceInStore: unmatched.price,
      stockInStore: unmatched.stockQuantity,
      syncStatus: "READY",
    },
  });

  await prisma.unmatchedStoreProduct.update({
    where: { id: unmatched.id },
    data: { ignored: true },
  });

  return NextResponse.json({
    publicationId: publication.id,
    catalogProductId: catalogProduct.id,
  });
}
