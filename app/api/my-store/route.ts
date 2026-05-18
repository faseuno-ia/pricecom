// GET /api/my-store — estado de la tienda conectada del usuario (sin secretos).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";

export async function GET() {
  const session = await requireSession();

  const store = await prisma.store.findFirst({
    where: { userId: session.user.id },
    include: {
      integrations: {
        select: {
          id: true,
          status: true,
          lastConnectionCheck: true,
          lastError: true,
          consumerKeyEncrypted: true, // solo para saber si está configurada
          createdAt: true,
          updatedAt: true,
        },
        orderBy: { createdAt: "desc" },
        take: 1,
      },
      _count: { select: { publications: true, categories: true } },
    },
  });

  if (!store) {
    return NextResponse.json({ store: null });
  }

  // KPIs del catálogo publicado
  const [active, draft, paused, error, pendingSync, unmatched] =
    await Promise.all([
      prisma.productPublication.count({
        where: { storeId: store.id, status: "ACTIVE" },
      }),
      prisma.productPublication.count({
        where: { storeId: store.id, status: "DRAFT" },
      }),
      prisma.productPublication.count({
        where: { storeId: store.id, status: "PAUSED" },
      }),
      prisma.productPublication.count({
        where: { storeId: store.id, status: "ERROR" },
      }),
      prisma.productPublication.count({
        where: { storeId: store.id, pendingSync: true },
      }),
      // "No vinculados" se cuenta cuando hagamos el sync de productos. Por
      // ahora exponemos un placeholder (lo va a alimentar /sync/products).
      Promise.resolve(0),
    ]);

  const integration = store.integrations[0]
    ? {
        id: store.integrations[0].id,
        status: store.integrations[0].status,
        lastConnectionCheck: store.integrations[0].lastConnectionCheck,
        lastError: store.integrations[0].lastError,
        hasCredentials: !!store.integrations[0].consumerKeyEncrypted,
        createdAt: store.integrations[0].createdAt,
      }
    : null;

  return NextResponse.json({
    store: {
      id: store.id,
      name: store.name,
      platform: store.platform,
      url: store.url,
      isActive: store.isActive,
      createdAt: store.createdAt,
      publicationsCount: store._count.publications,
      categoriesCount: store._count.categories,
    },
    integration,
    kpis: { active, draft, paused, error, pendingSync, unmatched },
  });
}
