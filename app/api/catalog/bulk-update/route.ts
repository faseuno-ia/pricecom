import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { InternalPublicationStatus } from "@prisma/client";
import { z } from "zod";

// Acciones de usuario — NUNCA tocan supplierStatus (ese estado lo maneja
// exclusivamente el worker / importador en base a presencia del producto en
// el catálogo del proveedor).
const STATUS_ACTIONS = ["ignore", "restore", "prepare", "pause"] as const;
const ACTIONS = [
  ...STATUS_ACTIONS,
  "clear_margin",
  "clear_price",
  "copy_own_stock",
  "remove_own_stock",
] as const;

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

  // copy_own_stock: marca los productos como stock propio (sin duplicar).
  // A diferencia del modelo viejo, ya no se crea un CatalogProduct paralelo
  // en el provider OWN_STOCK — la marca vive sobre la misma fila.
  if (action === "copy_own_stock") {
    const result = await prisma.catalogProduct.updateMany({
      where: { id: { in: productIds }, userId: session.user.id },
      data: { stockSource: "OWN" },
    });
    return NextResponse.json({ updated: result.count });
  }

  // remove_own_stock: revierte a stockSource=SUPPLIER. Si el producto está
  // PUBLISHED|PREPARED y el proveedor ya lo dio de baja (SUPPLIER_REMOVED),
  // lo auto-pausamos porque sin proveedor y sin stock propio no hay manera
  // de abastecerlo.
  if (action === "remove_own_stock") {
    const [revert, autoPause] = await prisma.$transaction([
      prisma.catalogProduct.updateMany({
        where: { id: { in: productIds }, userId: session.user.id },
        data: { stockSource: "SUPPLIER" },
      }),
      prisma.catalogProduct.updateMany({
        where: {
          id: { in: productIds },
          userId: session.user.id,
          supplierStatus: "SUPPLIER_REMOVED",
          internalStatus: { in: ["PUBLISHED", "PREPARED"] },
        },
        data: { internalStatus: "PAUSED" },
      }),
    ]);
    return NextResponse.json({
      updated: revert.count,
      autoPaused: autoPause.count,
    });
  }

  const internalStatus = actionMap[action];

  const result = await prisma.catalogProduct.updateMany({
    where: { id: { in: productIds }, userId: session.user.id },
    data: { internalStatus },
  });

  return NextResponse.json({ updated: result.count });
}
