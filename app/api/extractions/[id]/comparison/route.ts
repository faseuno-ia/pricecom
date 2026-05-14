import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireSession();

  const job = await prisma.extractionJob.findFirst({
    where: { id: params.id, userId: session.user.id },
    select: { id: true },
  });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const comparison = await prisma.extractionComparison.findUnique({
    where: { jobId: params.id },
    include: {
      changes: { orderBy: [{ changeType: "asc" }, { name: "asc" }] },
      previousJob: { select: { createdAt: true } },
    },
  });

  return NextResponse.json(comparison);
}
