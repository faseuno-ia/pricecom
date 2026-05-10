import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { scraperConfigSchema } from "@/lib/utils/schemas";

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const config = await prisma.providerScraperConfig.findUnique({
    where: { providerId: params.id },
  });
  return NextResponse.json(config ?? {});
}

export async function POST(req: NextRequest, { params }: { params: { id: string } }) {
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
