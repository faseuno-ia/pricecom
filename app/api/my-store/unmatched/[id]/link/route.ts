// POST /api/my-store/unmatched/[id]/link — vincula manualmente un producto
// WooCommerce sin match a un CatalogProduct existente.
//
// Body: { catalogProductId: string }
//
// Refleja el estado real del producto en Woo al momento del link:
//   - Si externalStatus = "publish" → ProductPublication.status = ACTIVE +
//     CatalogProduct.internalStatus = PUBLISHED.
//   - Otro caso → DRAFT + PREPARED.
// syncStatus = SYNCED en ambos casos: el priceInStore acaba de leerse del
// último sync con la tienda, así que no hay drift conocido.
//
// Seed de commercialTitle desde woo.name con userEdited=false (la edición
// del drawer flipea el flag y bloquea futuros pulls). Marca el unmatched
// como ignored.

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

  // Derivamos el estado de la publicación a partir del externalStatus
  // capturado en el último sync. Por defecto DRAFT/PREPARED si no sabemos.
  const isPublished = unmatched.externalStatus === "publish";
  const pubStatus = isPublished ? "ACTIVE" : "DRAFT";
  const nextInternal = isPublished ? "PUBLISHED" : "PREPARED";

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
      externalStatus: unmatched.externalStatus,
      externalUrl: unmatched.permalink,
      priceInStore: unmatched.price,
      stockInStore: unmatched.stockQuantity,
      status: pubStatus,
      syncStatus: "SYNCED",
      pendingSync: false,
      lastSyncedAt: new Date(),
      lastSyncAt: new Date(),
      commercialTitle: unmatched.name,
      commercialTitleUserEdited: false,
    },
    update: {
      externalProductId: unmatched.externalProductId,
      externalSku: unmatched.externalSku,
      externalStatus: unmatched.externalStatus,
      externalUrl: unmatched.permalink,
      priceInStore: unmatched.price,
      stockInStore: unmatched.stockQuantity,
      status: pubStatus,
      syncStatus: "SYNCED",
      pendingSync: false,
      lastSyncedAt: new Date(),
      lastSyncAt: new Date(),
    },
  });

  // Propagar al CatalogProduct el estado interno y un seed del título
  // comercial. Si el usuario ya editó commercialTitle, este update lo
  // pisa — aceptable como acción explícita del usuario al vincular.
  await prisma.catalogProduct.update({
    where: { id: catalogProduct.id },
    data: {
      internalStatus: nextInternal,
      commercialTitle: unmatched.name,
    },
  });

  await prisma.unmatchedStoreProduct.update({
    where: { id: unmatched.id },
    data: { ignored: true },
  });

  return NextResponse.json({
    publicationId: publication.id,
    catalogProductId: catalogProduct.id,
    status: pubStatus,
    internalStatus: nextInternal,
  });
}
