// PATCH /api/changes/[id]/review — marca un cambio como PENDING/REVIEWED/IGNORED.
// Ownership: el cambio pertenece a una comparison cuyo job es del usuario.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { ChangeReviewStatus } from "@prisma/client";

const bodySchema = z.object({
  status: z.enum(["PENDING", "REVIEWED", "IGNORED"]),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await requireSession();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validación falló", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const change = await prisma.productChange.findFirst({
    where: { id: params.id, comparison: { job: { userId: session.user.id } } },
    select: { id: true },
  });
  if (!change) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }

  const updated = await prisma.productChange.update({
    where: { id: change.id },
    data: {
      reviewStatus: parsed.data.status as ChangeReviewStatus,
      reviewedAt: parsed.data.status === "PENDING" ? null : new Date(),
    },
  });

  return NextResponse.json({
    id: updated.id,
    reviewStatus: updated.reviewStatus,
    reviewedAt: updated.reviewedAt,
  });
}
