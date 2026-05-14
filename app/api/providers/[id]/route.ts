import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { providerSchema } from "@/lib/utils/schemas";
import { encrypt } from "@/lib/utils/crypto";
import { requireSession } from "@/lib/auth";

// Verifica que el provider exista Y pertenezca al usuario logueado.
// Centralizado acá para no repetir el check en cada handler.
async function findOwnedProvider(id: string, userId: string) {
  const provider = await prisma.provider.findFirst({
    where: { id, userId },
    include: { scraperConfig: true },
  });
  return provider;
}

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireSession();
  const provider = await findOwnedProvider(params.id, session.user.id);
  if (!provider) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // Never expose password
  const { encryptedPassword: _, ...safe } = provider;
  return NextResponse.json(safe);
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireSession();
  const existing = await findOwnedProvider(params.id, session.user.id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const parsed = providerSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { password, ...data } = parsed.data as typeof parsed.data & { password?: string };

  const updateData: Record<string, unknown> = {
    ...data,
    username: data.requiresLogin ? data.username ?? null : null,
  };

  if (data.requiresLogin && password) {
    updateData.encryptedPassword = encrypt(password);
  } else if (!data.requiresLogin) {
    updateData.encryptedPassword = null;
  }

  const provider = await prisma.provider.update({
    where: { id: params.id },
    data: updateData,
  });

  const { encryptedPassword: _, ...safe } = provider;
  return NextResponse.json(safe);
}

// PATCH: actualizaciones parciales (ej: { isActive: false } para desactivar)
export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireSession();
  const existing = await findOwnedProvider(params.id, session.user.id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const body = await req.json();
  const allowed: Record<string, unknown> = {};
  if (typeof body.isActive === "boolean") allowed.isActive = body.isActive;

  if (Object.keys(allowed).length === 0) {
    return NextResponse.json({ error: "No hay campos válidos para actualizar" }, { status: 400 });
  }

  const provider = await prisma.provider.update({
    where: { id: params.id },
    data: allowed,
  });
  const { encryptedPassword: _, ...safe } = provider;
  return NextResponse.json(safe);
}

// DELETE: borra el proveedor y en cascada manual sus jobs (que cascadean a products/logs).
// La FK Provider→ExtractionJob no tiene onDelete:Cascade en el schema, por eso el borrado de
// jobs es explícito y todo va dentro de una transacción.
export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireSession();
  const existing = await findOwnedProvider(params.id, session.user.id);
  if (!existing) return NextResponse.json({ error: "Not found" }, { status: 404 });

  try {
    await prisma.$transaction([
      prisma.extractionJob.deleteMany({ where: { providerId: params.id } }),
      prisma.provider.delete({ where: { id: params.id } }),
    ]);
    return NextResponse.json({ ok: true });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message ?? "Error eliminando proveedor" },
      { status: 500 }
    );
  }
}
