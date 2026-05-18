import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { InternalPublicationStatus } from "@prisma/client";
import { z } from "zod";

// Acciones de usuario — NUNCA tocan supplierStatus (ese estado lo maneja
// exclusivamente el worker / importador en base a presencia del producto en
// el catálogo del proveedor).
const STATUS_ACTIONS = ["ignore", "restore", "prepare", "pause"] as const;
const ACTIONS = [...STATUS_ACTIONS, "clear_margin", "clear_price"] as const;

const bodySchema = z.object({
  productIds: z.array(z.string()).min(1).max(1000),
  action: z.enum(ACTIONS),
});

const actionMap: Record<
  (typeof STATUS_ACTIONS)[number],
  InternalPublicationStatus
> = {
  ignore: "IGNORED",
  restore: "NOT_PUBLISHED",
  prepare: "PREPARED",
  pause: "PAUSED",
};

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

  const { productIds, action } = parsed.data;

  if (action === "clear_margin") {
    const result = await prisma.catalogProduct.updateMany({
      where: { id: { in: productIds }, userId: session.user.id },
      data: { manualMargin: null },
    });
    return NextResponse.json({ updated: result.count });
  }

  // clear_price: limpia el override de finalPrice; el motor de pricing vuelve
  // a calcular el precio a partir de la regla aplicable.
  if (action === "clear_price") {
    const result = await prisma.catalogProduct.updateMany({
      where: { id: { in: productIds }, userId: session.user.id },
      data: { finalPrice: null },
    });
    return NextResponse.json({ updated: result.count });
  }

  const internalStatus = actionMap[action];

  const result = await prisma.catalogProduct.updateMany({
    where: { id: { in: productIds }, userId: session.user.id },
    data: { internalStatus },
  });

  return NextResponse.json({ updated: result.count });
}
