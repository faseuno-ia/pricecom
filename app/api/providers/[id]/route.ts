import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { providerSchema } from "@/lib/utils/schemas";
import { encrypt } from "@/lib/utils/crypto";

export async function GET(_req: NextRequest, { params }: { params: { id: string } }) {
  const provider = await prisma.provider.findUnique({
    where: { id: params.id },
    include: { scraperConfig: true },
  });
  if (!provider) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // Never expose password
  const { encryptedPassword: _, ...safe } = provider;
  return NextResponse.json(safe);
}

export async function PUT(req: NextRequest, { params }: { params: { id: string } }) {
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

  // Only update password if provided
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

export async function DELETE(_: NextRequest, { params }: { params: { id: string } }) {
  await prisma.provider.delete({ where: { id: params.id } });
  return NextResponse.json({ ok: true });
}
