import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const logs = await prisma.extractionLog.findMany({
    where: { jobId: params.id },
    orderBy: { createdAt: "asc" },
  });
  return NextResponse.json(logs);
}
