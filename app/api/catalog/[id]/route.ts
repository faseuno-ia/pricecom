import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { z } from "zod";

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireSession();

  const product = await prisma.catalogProduct.findFirst({
    where: { id: params.id, userId: session.user.id },
    include: {
      provider: {
        select: { id: true, name: true, baseUrl: true, requiresLogin: true },
      },
      images: { orderBy: { position: "asc" } },
      assignedCategory: { select: { id: true, name: true } },
      publications: {
        include: { store: { select: { id: true, name: true, platform: true } } },
      },
      latestExtractedProduct: {
        select: {
          id: true,
          jobId: true,
          extractedAt: true,
          productUrl: true,
          imageUrl: true,
        },
      },
    },
  });

  if (!product) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json(product);
}

// Solo campos comerciales editables — el worker NUNCA toca estos campos, y la
// API tampoco permite editar campos supplier* por esta ruta.
const patchSchema = z
  .object({
    commercialTitle: z.string().nullable().optional(),
    commercialName: z.string().nullable().optional(),
    commercialDescription: z.string().nullable().optional(),
    finalPrice: z.number().nullable().optional(),
    manualMargin: z.number().nullable().optional(),
    manualPrice: z.number().nullable().optional(),
    assignedCategoryId: z.string().nullable().optional(),
    pricingRuleId: z.string().nullable().optional(),
    notes: z.string().nullable().optional(),
  })
  .strict();

export async function PATCH(req: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireSession();

  const owned = await prisma.catalogProduct.findFirst({
    where: { id: params.id, userId: session.user.id },
    select: { id: true },
  });
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }

  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validación falló", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const updated = await prisma.catalogProduct.update({
    where: { id: params.id },
    data: parsed.data,
    include: {
      provider: { select: { id: true, name: true, baseUrl: true } },
      images: { orderBy: { position: "asc" } },
      assignedCategory: { select: { id: true, name: true } },
      publications: { select: { status: true, storeId: true } },
    },
  });

  return NextResponse.json(updated);
}
