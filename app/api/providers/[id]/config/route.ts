import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { scraperConfigSchema } from "@/lib/utils/schemas";
import { requireSession } from "@/lib/auth";

async function assertOwnership(providerId: string, userId: string) {
  const owned = await prisma.provider.findFirst({
    where: { id: providerId, userId },
    select: { id: true },
  });
  return !!owned;
}

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireSession();
  if (!(await assertOwnership(params.id, session.user.id))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const config = await prisma.providerScraperConfig.findUnique({
    where: { providerId: params.id },
  });
  return NextResponse.json(config ?? {});
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireSession();
  if (!(await assertOwnership(params.id, session.user.id))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  const body = await req.json();
  const parsed = scraperConfigSchema.safeParse({ ...body, providerId: params.id });
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const config = await prisma.providerScraperConfig.upsert({
    where: { providerId: params.id },
    create: parsed.data,
    update: parsed.data,
  });

  return NextResponse.json(config);
}
