import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { InternalPublicationStatus, PublicationStatus } from "@prisma/client";
import { z } from "zod";
import { logInfo } from "@/lib/events/event-log";

// ACTIVE/PAUSED/DRAFT → ProductPublication.status (requiere Store)
// IGNORED → CatalogProduct.internalStatus (acción del usuario, no del proveedor)
const PUB_STATUSES = ["DRAFT", "ACTIVE", "PAUSED"] as const;

const bodySchema = z.object({
  status: z.enum([...PUB_STATUSES, "IGNORED", "RESTORE"]),
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

  // Rama 1: status interno (no requiere store).
  // - IGNORED  → CatalogProduct.internalStatus = IGNORED
  // - RESTORE  → CatalogProduct.internalStatus = NOT_PUBLISHED
  if (status === "IGNORED" || status === "RESTORE") {
    const next: InternalPublicationStatus =
      status === "IGNORED" ? "IGNORED" : "NOT_PUBLISHED";

    // Leer estado previo para el log (sin esto, "qué pasó con DURAVIT?" no
    // tiene respuesta: era exactamente esta ruta y no dejaba rastro).
    const prev = await prisma.catalogProduct.findUnique({
      where: { id: params.id },
      select: { internalStatus: true, supplierName: true },
    });

    const updated = await prisma.catalogProduct.update({
      where: { id: params.id },
      data: { internalStatus: next },
    });

    if (prev && prev.internalStatus !== next) {
      const isIgnore = status === "IGNORED";
      await logInfo({
        source: "USER",
        type: isIgnore ? "USER_IGNORED_PRODUCT" : "USER_RESTORED_PRODUCT",
        title: isIgnore
          ? `Producto ignorado: ${prev.supplierName?.slice(0, 80) ?? params.id}`
          : `Producto restaurado: ${prev.supplierName?.slice(0, 80) ?? params.id}`,
        userId: session.user.id,
        productId: params.id,
        metadata: {
          previousStatus: prev.internalStatus,
          newStatus: next,
        },
      });
    }

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
