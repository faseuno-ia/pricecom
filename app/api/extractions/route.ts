import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";

export async function GET() {
  const jobs = await prisma.extractionJob.findMany({
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { provider: { select: { name: true } } },
  });
  return NextResponse.json(jobs);
}
