// POST /api/my-store/sync/categories — importa categorías desde la tienda
// externa y resuelve la jerarquía parent/child en dos pasadas.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { WooCommerceClient } from "@/lib/integrations/woocommerce/client";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST() {
  const session = await requireSession();

  const store = await prisma.store.findFirst({
    where: { userId: session.user.id },
    include: {
      integrations: { orderBy: { createdAt: "desc" }, take: 1 },
    },
  });
  if (!store) {
    return NextResponse.json({ error: "Sin tienda conectada" }, { status: 404 });
  }
  const integration = store.integrations[0];
  if (!integration) {
    return NextResponse.json(
      { error: "Sin integración configurada" },
      { status: 400 }
    );
  }
  if (store.platform !== "WOOCOMMERCE") {
    return NextResponse.json(
      { error: "Solo WooCommerce soportado por ahora" },
      { status: 400 }
    );
  }

  let client: WooCommerceClient;
  try {
    client = WooCommerceClient.fromIntegration({
      storeUrl: store.url,
      consumerKeyEncrypted: integration.consumerKeyEncrypted,
      consumerSecretEncrypted: integration.consumerSecretEncrypted,
    });
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error de credenciales" },
      { status: 400 }
    );
  }

  let wooCategories;
  try {
    wooCategories = await client.getCategories();
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Error de API" },
      { status: 502 }
    );
  }

  let created = 0;
  let updated = 0;

  // Pasada 1: upsert sin resolver parentId interno.
  for (const cat of wooCategories) {
    const result = await prisma.storeCategory.upsert({
      where: {
        storeId_externalCategoryId: {
          storeId: store.id,
          externalCategoryId: String(cat.id),
        },
      },
      create: {
        storeId: store.id,
        externalCategoryId: String(cat.id),
        name: cat.name,
        slug: cat.slug,
        parentExternalId: cat.parent > 0 ? String(cat.parent) : null,
      },
      update: {
        name: cat.name,
        slug: cat.slug,
        parentExternalId: cat.parent > 0 ? String(cat.parent) : null,
      },
    });
    if (result.createdAt.getTime() === result.updatedAt.getTime()) created++;
    else updated++;
  }

  // Pasada 2: resolver parentId interno usando parentExternalId.
  const allCats = await prisma.storeCategory.findMany({
    where: { storeId: store.id },
    select: { id: true, externalCategoryId: true, parentExternalId: true },
  });
  const byExternal = new Map(allCats.map((c) => [c.externalCategoryId, c.id]));

  for (const cat of allCats) {
    const targetParentId = cat.parentExternalId
      ? byExternal.get(cat.parentExternalId) ?? null
      : null;
    await prisma.storeCategory.update({
      where: { id: cat.id },
      data: { parentId: targetParentId },
    });
  }

  return NextResponse.json({
    imported: created,
    updated,
    total: wooCategories.length,
  });
}
