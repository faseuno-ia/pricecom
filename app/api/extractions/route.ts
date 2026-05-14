import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";

export async function GET() {
  const session = await requireSession();
  const jobs = await prisma.extractionJob.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { provider: { select: { name: true } } },
  });
  return NextResponse.json(jobs);
}
