import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireSession();
  // Validar que el job pertenezca al usuario antes de exponer los logs.
  const owned = await prisma.extractionJob.findFirst({
    where: { id: params.id, userId: session.user.id },
    select: { id: true },
  });
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const logs = await prisma.extractionLog.findMany({
    where: { jobId: params.id },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json(logs);
}
