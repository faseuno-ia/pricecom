// POST /api/changes/bulk-review — marca múltiples cambios al mismo estado.
// Ownership: filtra por comparison.job.userId en el updateMany.

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { ChangeReviewStatus } from "@prisma/client";

const bodySchema = z.object({
  changeIds: z.array(z.string().min(1)).min(1).max(2000),
  status: z.enum(["PENDING", "REVIEWED", "IGNORED"]),
});

export async function POST(req: NextRequest) {
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
  const { changeIds, status } = parsed.data;

  const result = await prisma.productChange.updateMany({
    where: {
      id: { in: changeIds },
      comparison: { job: { userId: session.user.id } },
    },
    data: {
      reviewStatus: status as ChangeReviewStatus,
      reviewedAt: status === "PENDING" ? null : new Date(),
    },
  });

  return NextResponse.json({ updated: result.count });
}
