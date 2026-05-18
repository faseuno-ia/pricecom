// POST /api/my-store/unmatched/[id]/ignore — marca el unmatched como ignorado.
// El siguiente sync de productos lo va a designorar si vuelve a aparecer.

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
    data: { ignored: true },
  });

  return NextResponse.json({ ok: true });
}
