import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { startExtractionSchema } from "@/lib/utils/schemas";

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = startExtractionSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { providerId, startUrl } = parsed.data;

  // Verify provider exists and is active
  const provider = await prisma.provider.findUnique({ where: { id: providerId } });
  if (!provider) {
    return NextResponse.json({ error: "Proveedor no encontrado" }, { status: 404 });
  }
  if (!provider.isActive) {
    return NextResponse.json({ error: "El proveedor está inactivo" }, { status: 400 });
  }

  // Check no job is already running for this provider
  const running = await prisma.extractionJob.findFirst({
    where: { providerId, status: { in: ["PENDING", "RUNNING"] } },
  });
  if (running) {
    return NextResponse.json(
      { error: "Ya hay una extracción en curso para este proveedor", jobId: running.id },
      { status: 409 }
    );
  }

  // Create job (worker will pick it up)
  const job = await prisma.extractionJob.create({
    data: {
      providerId,
      startUrl: startUrl || null,
      status: "PENDING",
    },
  });

  return NextResponse.json({ jobId: job.id, status: "PENDING" }, { status: 201 });
}
