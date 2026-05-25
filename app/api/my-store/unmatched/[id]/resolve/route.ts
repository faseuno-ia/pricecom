// POST /api/my-store/unmatched/[id]/resolve — marca el unmatched como
// resuelto por descarte manual (el usuario eligió "No vincular").
//
// resolved=true se usa también cuando link/create-catalog procesan el
// unmatched. La diferencia entre descarte manual y resolución por
// link/create-catalog se infiere desde fuera mirando si existe una
// ProductPublication con el mismo externalProductId.

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";

export async function POST(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await requireSession();

  const unmatched = await prisma.unmatchedStoreProduct.findFirst({
    where: { id: params.id, store: { userId: session.user.id } },
    select: { id: true },
  });
  if (!unmatched) {
    return NextResponse.json({ error: "No encontrado" }, { status: 404 });
  }

  await prisma.unmatchedStoreProduct.update({
    where: { id: unmatched.id },
    data: { resolved: true },
  });

  return NextResponse.json({ ok: true });
}
