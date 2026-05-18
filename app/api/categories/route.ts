// GET    /api/categories  — lista plana (id, name, parentId).
// POST   /api/categories  — crea una nueva categoría.
//
// Las Category son globales por ahora (no tienen userId). Mantenemos esa
// decisión hasta que aparezca un caso multi-tenant real.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
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

const postSchema = z.object({
  name: z.string().min(1).max(100).trim(),
  parentId: z.string().min(1).nullable().optional(),
});

export async function POST(req: NextRequest) {
  await requireSession();

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
  const { name, parentId = null } = parsed.data;

  // Validar parent si vino.
  if (parentId) {
    const parent = await prisma.category.findUnique({
      where: { id: parentId },
      select: { id: true },
    });
    if (!parent) {
      return NextResponse.json(
        { error: "Categoría padre no encontrada" },
        { status: 404 }
      );
    }
  }

  // Deduplicación: misma (name, parentId) — case-insensitive — ya existe.
  const dup = await prisma.category.findFirst({
    where: {
      name: { equals: name, mode: "insensitive" },
      parentId: parentId,
    },
    select: { id: true, name: true },
  });
  if (dup) {
    return NextResponse.json(
      { error: `Ya existe una categoría "${dup.name}" en ese nivel`, id: dup.id },
      { status: 409 }
    );
  }

  const created = await prisma.category.create({
    data: { name, parentId },
    select: { id: true, name: true, parentId: true },
  });

  return NextResponse.json(created, { status: 201 });
}
