import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const job = await prisma.extractionJob.findUnique({
    where: { id: params.id },
    select: {
      status: true,
      progress: true,
      totalProducts: true,
      errorMessage: true,
      excelFilePath: true,
      excelFileUrl: true,
      startedAt: true,
      finishedAt: true,
    },
  });
  if (!job) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Get last 100 logs for display
  const logs = await prisma.extractionLog.findMany({
    where: { jobId: params.id },
    orderBy: { createdAt: "asc" },
    take: 100,
    select: { level: true, message: true, createdAt: true },
  });

  return NextResponse.json({ ...job, logs });
}
