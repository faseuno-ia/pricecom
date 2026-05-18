// GET /api/categories — lista plana de categorías internas (id, name, parentId).
// El cliente arma el árbol jerárquico para indentar el dropdown.

import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";

export async function GET() {
  await requireSession();

  const categories = await prisma.category.findMany({
    orderBy: { name: "asc" },
    select: { id: true, name: true, parentId: true },
  });

  return NextResponse.json(categories);
}
