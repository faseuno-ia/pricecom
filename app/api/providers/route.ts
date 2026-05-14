import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { providerSchema } from "@/lib/utils/schemas";
import { encrypt } from "@/lib/utils/crypto";
import { requireSession } from "@/lib/auth";

export async function GET() {
  const session = await requireSession();
  const providers = await prisma.provider.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    include: { _count: { select: { extractionJobs: true } } },
  });
  return NextResponse.json(providers);
}

export async function POST(req: NextRequest) {
  const session = await requireSession();
  const body = await req.json();
  const parsed = providerSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { password, ...data } = parsed.data as typeof parsed.data & { password?: string };

  const provider = await prisma.provider.create({
    data: {
      ...data,
      userId: session.user.id,
      username: data.requiresLogin ? data.username ?? null : null,
      encryptedPassword:
        data.requiresLogin && password ? encrypt(password) : null,
    },
  });

  return NextResponse.json(provider, { status: 201 });
}
