import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { CatalogProductStatus, PublicationStatus } from "@prisma/client";
import { z } from "zod";

// ACTIVE/PAUSED/DRAFT → ProductPublication.status (requiere Store)
// IGNORED/ARCHIVED → CatalogProduct.supplierStatus
const PUB_STATUSES = ["DRAFT", "ACTIVE", "PAUSED"] as const;
const CATALOG_STATUSES = ["IGNORED", "ARCHIVED", "ACTIVE"] as const; // ACTIVE = "unignorar"

const bodySchema = z.object({
  status: z.enum([...PUB_STATUSES, "IGNORED", "ARCHIVED"]),
  storeId: z.string().optional(),
});

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireSession();

  const product = await prisma.catalogProduct.findFirst({
    where: { id: params.id, userId: session.user.id },
    select: { id: true },
  });
  if (!product) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Validación falló" }, { status: 400 });
  }

  const { status, storeId } = parsed.data;

  // Rama 1: status de catálogo (no requiere store)
  if (status === "IGNORED" || status === "ARCHIVED") {
    const updated = await prisma.catalogProduct.update({
      where: { id: params.id },
      data: { supplierStatus: status as CatalogProductStatus },
    });
    return NextResponse.json(updated);
  }

  // Rama 2: status de publicación (requiere store)
  // Si no se especifica storeId pero el user tiene exactamente 1 store, usar esa.
  let targetStoreId = storeId;
  if (!targetStoreId) {
    const stores = await prisma.store.findMany({
      where: { isActive: true },
      select: { id: true },
      take: 2,
    });
    if (stores.length === 0) {
      return NextResponse.json(
        { error: "No hay tiendas configuradas. Agregá una tienda primero." },
        { status: 400 }
      );
    }
    if (stores.length > 1) {
      return NextResponse.json(
        { error: "Múltiples tiendas configuradas. Especificá storeId." },
        { status: 400 }
      );
    }
    targetStoreId = stores[0].id;
  }

  const publication = await prisma.productPublication.upsert({
    where: {
      catalogProductId_storeId: {
        catalogProductId: params.id,
        storeId: targetStoreId,
      },
    },
    create: {
      catalogProductId: params.id,
      storeId: targetStoreId,
      status: status as PublicationStatus,
      publishedAt: status === "ACTIVE" ? new Date() : null,
      pausedAt: status === "PAUSED" ? new Date() : null,
    },
    update: {
      status: status as PublicationStatus,
      ...(status === "ACTIVE" ? { publishedAt: new Date(), pausedAt: null } : {}),
      ...(status === "PAUSED" ? { pausedAt: new Date() } : {}),
    },
  });

  return NextResponse.json(publication);
}
