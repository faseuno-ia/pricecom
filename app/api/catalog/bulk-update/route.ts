import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import {
  CatalogProductStatus,
  InternalPublicationStatus,
  Prisma,
} from "@prisma/client";
import { z } from "zod";

const ACTIONS = ["archive", "ignore", "restore", "prepare", "pause"] as const;

const bodySchema = z.object({
  productIds: z.array(z.string()).min(1).max(1000),
  action: z.enum(ACTIONS),
});

// Mapeo acción → cambios en CatalogProduct.
// `restore` reactiva el producto desde un estado terminal (ARCHIVED/IGNORED).
const actionMap: Record<
  (typeof ACTIONS)[number],
  {
    supplierStatus?: CatalogProductStatus;
    internalStatus: InternalPublicationStatus;
  }
> = {
  archive: { internalStatus: "ARCHIVED" },
  ignore: { internalStatus: "IGNORED" },
  restore: { supplierStatus: "ACTIVE", internalStatus: "NOT_PUBLISHED" },
  prepare: { internalStatus: "PREPARED" },
  pause: { internalStatus: "PAUSED" },
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
  const changes = actionMap[action];

  // Solo updateamos los campos que la acción cambia (no sobreescribir
  // supplierStatus en acciones que no lo tocan).
  const data: Prisma.CatalogProductUpdateManyMutationInput = {
    internalStatus: changes.internalStatus,
  };
  if (changes.supplierStatus) data.supplierStatus = changes.supplierStatus;

  const result = await prisma.catalogProduct.updateMany({
    where: { id: { in: productIds }, userId: session.user.id },
    data,
  });

  return NextResponse.json({ updated: result.count });
}
