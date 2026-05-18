// POST /api/my-store/categories/[id]/link — vincula una StoreCategory con
// una Category interna. Body: { categoryId: string | null } (null desvincula).

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";

const bodySchema = z.object({
  categoryId: z.string().min(1).nullable(),
});

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

  // Ownership de la StoreCategory.
  const storeCat = await prisma.storeCategory.findFirst({
    where: { id: params.id, store: { userId: session.user.id } },
    select: { id: true },
  });
  if (!storeCat) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }

  // Si viene categoryId, validar que existe (Category es global, no scoped).
  if (parsed.data.categoryId) {
    const cat = await prisma.category.findUnique({
      where: { id: parsed.data.categoryId },
      select: { id: true },
    });
    if (!cat) {
      return NextResponse.json(
        { error: "Category interna no encontrada" },
        { status: 404 }
      );
    }
  }

  const updated = await prisma.storeCategory.update({
    where: { id: storeCat.id },
    data: { categoryId: parsed.data.categoryId },
  });

  return NextResponse.json({ id: updated.id, categoryId: updated.categoryId });
}
