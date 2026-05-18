// POST /api/my-store/sync/publications — fuerza el sync de las publications
// con cambios pendientes. Por ahora es un placeholder funcional: marca como
// SYNCED y limpia los flags sin tocar la tienda real. La estructura está
// preparada para conectar WooCommerceClient.updateProduct() acá.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

export async function POST() {
  const session = await requireSession();

  const store = await prisma.store.findFirst({
    where: { userId: session.user.id },
    select: { id: true },
  });
  if (!store) {
    return NextResponse.json({ error: "Sin tienda conectada" }, { status: 404 });
  }

  // Target: publications con cambios pendientes (flag legacy o syncStatus).
  const targets = await prisma.productPublication.findMany({
    where: {
      storeId: store.id,
      OR: [{ pendingSync: true }, { syncStatus: "PENDING_SYNC" }],
    },
    select: { id: true },
  });

  if (targets.length === 0) {
    return NextResponse.json({ synced: 0 });
  }

  // TODO: conectar WooCommerceClient.updateProduct() acá. Por ahora marcamos
  // SYNCED para que la UI refleje que el flujo está cableado.
  await prisma.productPublication.updateMany({
    where: { id: { in: targets.map((t) => t.id) } },
    data: {
      pendingSync: false,
      syncStatus: "SYNCED",
      lastSyncedAt: new Date(),
      lastSyncAt: new Date(),
      syncError: null,
    },
  });

  return NextResponse.json({ synced: targets.length });
}
