// Endpoints masivos para asignar/quitar una categoría a múltiples productos.
//   POST   — agrega categoryId a productIds (upsert, no duplica).
//            Si isPrimary=true, marca como primaria en cada uno (y desmarca las
//            primarias previas de ese producto).
//   DELETE — quita categoryId de productIds.
// Ambos llaman a syncPrimaryCategory por producto al final.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { syncPrimaryCategory } from "@/lib/catalog/product-categories";
import { markPublicationsDrift } from "@/lib/catalog/mark-publications-drift";

const postSchema = z.object({
  productIds: z.array(z.string().min(1)).min(1).max(1000),
  categoryId: z.string().min(1),
  isPrimary: z.boolean().optional(),
});

const deleteSchema = z.object({
  productIds: z.array(z.string().min(1)).min(1).max(1000),
  categoryId: z.string().min(1),
});

async function assertOwnership(productIds: string[], userId: string): Promise<string[]> {
  const owned = await prisma.catalogProduct.findMany({
    where: { id: { in: productIds }, userId },
    select: { id: true },
  });
  return owned.map((p) => p.id);
}

export async function POST(req: NextRequest) {
  const session = await requireSession();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validación falló", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { productIds, categoryId, isPrimary = false } = parsed.data;

  const category = await prisma.category.findUnique({
    where: { id: categoryId },
    select: { id: true },
  });
  if (!category) {
    return NextResponse.json({ error: "Categoría no encontrada" }, { status: 404 });
  }

  const ownedIds = await assertOwnership(productIds, session.user.id);
  if (ownedIds.length === 0) {
    return NextResponse.json({ error: "Sin productos" }, { status: 404 });
  }

  let added = 0;
  let skipped = 0;

  for (const pid of ownedIds) {
    if (isPrimary) {
      await prisma.catalogProductCategory.updateMany({
        where: { catalogProductId: pid, isPrimary: true },
        data: { isPrimary: false },
      });
    }
    const existing = await prisma.catalogProductCategory.findUnique({
      where: {
        catalogProductId_categoryId: { catalogProductId: pid, categoryId },
      },
      select: { catalogProductId: true, isPrimary: true },
    });
    if (existing) {
      if (isPrimary && !existing.isPrimary) {
        await prisma.catalogProductCategory.update({
          where: {
            catalogProductId_categoryId: { catalogProductId: pid, categoryId },
          },
          data: { isPrimary: true },
        });
        added++;
      } else {
        skipped++;
      }
    } else {
      await prisma.catalogProductCategory.create({
        data: { catalogProductId: pid, categoryId, isPrimary },
      });
      added++;
    }
    await syncPrimaryCategory(prisma, pid);
  }

  // Drift: categorías llegan a Woo vía StoreCategory.externalCategoryId.
  await markPublicationsDrift(prisma, ownedIds);

  return NextResponse.json({ added, skipped, total: ownedIds.length });
}

export async function DELETE(req: NextRequest) {
  const session = await requireSession();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validación falló", details: parsed.error.flatten() },
      { status: 400 }
    );
  }
  const { productIds, categoryId } = parsed.data;

  const ownedIds = await assertOwnership(productIds, session.user.id);
  if (ownedIds.length === 0) {
    return NextResponse.json({ error: "Sin productos" }, { status: 404 });
  }

  const deleted = await prisma.catalogProductCategory.deleteMany({
    where: {
      catalogProductId: { in: ownedIds },
      categoryId,
    },
  });

  // Promover/limpiar primaria por cada producto afectado.
  for (const pid of ownedIds) {
    await syncPrimaryCategory(prisma, pid);
  }

  await markPublicationsDrift(prisma, ownedIds);

  return NextResponse.json({ removed: deleted.count, total: ownedIds.length });
}
