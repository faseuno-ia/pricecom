import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { startExtractionSchema } from "@/lib/utils/schemas";
import { requireSession } from "@/lib/auth";

export async function POST(req: NextRequest) {
  const session = await requireSession();
  const body = await req.json();
  const parsed = startExtractionSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }

  const { providerId, startUrl } = parsed.data;

  // Verify provider exists, belongs to the user, and is active
  const provider = await prisma.provider.findFirst({
    where: { id: providerId, userId: session.user.id },
  });
  if (!provider) {
    return NextResponse.json({ error: "Proveedor no encontrado" }, { status: 404 });
  }
  if (!provider.isActive) {
    return NextResponse.json({ error: "El proveedor está inactivo" }, { status: 400 });
  }

  // Check no job is already running for this provider (scoped to this user)
  const running = await prisma.extractionJob.findFirst({
    where: { providerId, userId: session.user.id, status: { in: ["PENDING", "RUNNING"] } },
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
      userId: session.user.id,
      startUrl: startUrl || null,
      status: "PENDING",
    },
  });

  return NextResponse.json({ jobId: job.id, status: "PENDING" }, { status: 201 });
}
