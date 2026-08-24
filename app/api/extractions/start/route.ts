import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { startExtractionSchema } from "@/lib/utils/schemas";
import { requireSession } from "@/lib/auth";
import { emitWake } from "@/lib/worker/wake-client";

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

  // Create job
  const job = await prisma.extractionJob.create({
    data: {
      providerId,
      userId: session.user.id,
      startUrl: startUrl || null,
      status: "PENDING",
    },
  });

  // NEON-GATE2A-EXEC-1 · Despertar al worker. La señal SÓLO despierta: la autoridad de ejecución
  // es la fila recién creada, y el claim dirigido del worker decide.
  //
  // emitWake es TOTAL (nunca lanza) por contrato: WAKE_FAILURE_BREAKS_CREATE = false. El job ya
  // está creado y es redispatchable pase lo que pase, así que el resultado del wake viaja DENTRO
  // de la respuesta de éxito en vez de convertirse en un error.
  //
  // Sin WORKER_WAKE_URL / WORKER_WAKE_SECRET no se hace ninguna llamada: ausencia de
  // configuración significa no intentar, no fallar.
  const wake = await emitWake(job.id);

  return NextResponse.json({ jobId: job.id, status: "PENDING", wake }, { status: 201 });
}
