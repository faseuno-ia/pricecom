// Endpoints para gestionar las categorías asignadas a un CatalogProduct.
//   GET    — lista las categorías del producto (con isPrimary).
//   POST   — agrega una categoría. Body: { categoryId, isPrimary? }.
//            Si isPrimary=true, desmarca las demás y actualiza assignedCategoryId.
//   DELETE — quita una categoría. Body: { categoryId }.
//            Si era la primaria, syncPrimaryCategory promueve la siguiente.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { syncPrimaryCategory } from "@/lib/catalog/product-categories";
import { logInfo } from "@/lib/events/event-log";

async function findOwnedProduct(productId: string, userId: string) {
  return prisma.catalogProduct.findFirst({
    where: { id: productId, userId },
    select: { id: true },
  });
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await requireSession();
  const product = await findOwnedProduct(params.id, session.user.id);
  if (!product) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const rows = await prisma.catalogProductCategory.findMany({
    where: { catalogProductId: product.id },
    include: { category: { select: { id: true, name: true, parentId: true } } },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
  });

  return NextResponse.json({
    categories: rows.map((r) => ({
      id: r.category.id,
      name: r.category.name,
      parentId: r.category.parentId,
      isPrimary: r.isPrimary,
    })),
  });
}

const postSchema = z.object({
  categoryId: z.string().min(1),
  isPrimary: z.boolean().optional(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await requireSession();
  const product = await findOwnedProduct(params.id, session.user.id);
  if (!product) return NextResponse.json({ error: "Not found" }, { status: 404 });

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
  const { categoryId, isPrimary = false } = parsed.data;

  const category = await prisma.category.findUnique({
    where: { id: categoryId },
    select: { id: true },
  });
  if (!category) {
    return NextResponse.json({ error: "Categoría no encontrada" }, { status: 404 });
  }

  // Si la nueva entra como primaria, desmarcamos las primarias previas.
  if (isPrimary) {
    await prisma.catalogProductCategory.updateMany({
      where: { catalogProductId: product.id, isPrimary: true },
      data: { isPrimary: false },
    });
  }

  await prisma.catalogProductCategory.upsert({
    where: {
      catalogProductId_categoryId: {
        catalogProductId: product.id,
        categoryId,
      },
    },
    create: {
      catalogProductId: product.id,
      categoryId,
      isPrimary,
    },
    update: isPrimary ? { isPrimary: true } : {},
  });

  await syncPrimaryCategory(prisma, product.id);
  await logInfo({
    source: "USER",
    type: "USER_CHANGED_CATEGORY",
    title: "Categoría asignada",
    userId: session.user.id,
    productId: product.id,
    metadata: { categoryId, action: "add", isPrimary },
  });

  return NextResponse.json({ ok: true });
}

const deleteSchema = z.object({
  categoryId: z.string().min(1),
});

export async function DELETE(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await requireSession();
  const product = await findOwnedProduct(params.id, session.user.id);
  if (!product) return NextResponse.json({ error: "Not found" }, { status: 404 });

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

  await prisma.catalogProductCategory.deleteMany({
    where: { catalogProductId: product.id, categoryId: parsed.data.categoryId },
  });

  await syncPrimaryCategory(prisma, product.id);
  await logInfo({
    source: "USER",
    type: "USER_CHANGED_CATEGORY",
    title: "Categoría removida",
    userId: session.user.id,
    productId: product.id,
    metadata: { categoryId: parsed.data.categoryId, action: "remove" },
  });

  return NextResponse.json({ ok: true });
}
