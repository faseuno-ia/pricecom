// GET /api/my-store/categories — lista las StoreCategory del usuario con
// sugerencia de match contra Category interna y conteo de productos asociados
// (vía categoryInStore en ProductPublication).

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";

export async function GET() {
  const session = await requireSession();

  const store = await prisma.store.findFirst({
    where: { userId: session.user.id },
    select: { id: true },
  });
  if (!store) return NextResponse.json({ categories: [] });

  const storeCats = await prisma.storeCategory.findMany({
    where: { storeId: store.id },
    orderBy: [{ parentExternalId: "asc" }, { name: "asc" }],
    include: {
      category: { select: { id: true, name: true } },
      parent: { select: { id: true, name: true, externalCategoryId: true } },
    },
  });

  // Carga las Category internas para sugerir match por nombre exacto/contains.
  const internalCats = await prisma.category.findMany({
    select: { id: true, name: true },
  });
  const byNameLower = new Map(
    internalCats.map((c) => [c.name.trim().toLowerCase(), c])
  );

  // Conteo: cuántas publications tienen este nombre en categoryInStore.
  const counts = await prisma.productPublication.groupBy({
    by: ["categoryInStore"],
    where: { storeId: store.id, categoryInStore: { not: null } },
    _count: { _all: true },
  });
  const countByName = new Map(
    counts.map((c) => [c.categoryInStore?.toLowerCase() ?? "", c._count._all])
  );

  return NextResponse.json({
    categories: storeCats.map((c) => {
      let suggestion: {
        categoryId: string;
        name: string;
        score: number;
      } | null = null;
      if (!c.categoryId) {
        const exact = byNameLower.get(c.name.trim().toLowerCase());
        if (exact) {
          suggestion = { categoryId: exact.id, name: exact.name, score: 95 };
        } else {
          // contains lateral: si alguna interna contiene el name (o viceversa).
          const lc = c.name.trim().toLowerCase();
          const contains = internalCats.find(
            (ic) =>
              ic.name.toLowerCase().includes(lc) ||
              lc.includes(ic.name.toLowerCase())
          );
          if (contains) {
            suggestion = {
              categoryId: contains.id,
              name: contains.name,
              score: 70,
            };
          }
        }
      }
      return {
        id: c.id,
        externalCategoryId: c.externalCategoryId,
        name: c.name,
        slug: c.slug,
        parent: c.parent
          ? { id: c.parent.id, name: c.parent.name }
          : null,
        linkedCategory: c.category
          ? { id: c.category.id, name: c.category.name }
          : null,
        productsCount: countByName.get(c.name.toLowerCase()) ?? 0,
        suggestion,
      };
    }),
  });
}
