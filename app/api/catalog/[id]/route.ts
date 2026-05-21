import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { z } from "zod";
import {
  resolvePricing,
  type PricingRuleForCalc,
} from "@/lib/pricing/pricing-engine";

export async function GET(_: NextRequest, { params }: { params: { id: string } }) {
  const session = await requireSession();

  const [product, rules] = await Promise.all([
    prisma.catalogProduct.findFirst({
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
    }),
    prisma.pricingRule.findMany({
      where: { userId: session.user.id, isActive: true },
      select: {
        id: true,
        name: true,
        scope: true,
        scopeId: true,
        marginPercent: true,
        roundingMode: true,
        isActive: true,
        priority: true,
      },
    }),
  ]);

  if (!product) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const pricing = resolvePricing(
    {
      wholesalePrice: product.wholesalePrice,
      manualMargin: product.manualMargin,
      finalPrice: product.finalPrice,
      assignedCategoryId: product.assignedCategoryId,
      providerId: product.providerId,
    },
    rules as PricingRuleForCalc[]
  );

  return NextResponse.json({ ...product, pricing });
}

// Solo campos comerciales editables — el worker NUNCA toca estos campos
// cuando difieren del default del proveedor (regla user-first en
// upsert-catalog-products.ts), y la API tampoco permite editar campos
// supplier* por esta ruta.
const patchSchema = z
  .object({
    commercialTitle: z.string().nullable().optional(),
    commercialName: z.string().nullable().optional(),
    commercialDescription: z.string().nullable().optional(),
    publicationSku: z.string().min(1).max(100).nullable().optional(),
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

// DELETE: solo permitido para productos del stock propio (providerType=OWN_STOCK).
// Los productos scrapeados/importados no se borran a mano — se gestionan con
// supplierStatus / internalStatus.
export async function DELETE(
  _req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await requireSession();

  const product = await prisma.catalogProduct.findFirst({
    where: { id: params.id, userId: session.user.id },
    include: { provider: { select: { providerType: true } } },
  });

  if (!product) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  if (product.provider.providerType !== "OWN_STOCK") {
    return NextResponse.json(
      { error: "Solo se pueden eliminar productos del stock propio" },
      { status: 400 }
    );
  }

  // CatalogProductImage tiene onDelete: Cascade, pero somos explícitos para
  // que sea obvio si en el futuro alguien cambia esa relación.
  await prisma.catalogProductImage.deleteMany({
    where: { catalogProductId: params.id },
  });

  await prisma.catalogProduct.delete({ where: { id: params.id } });

  return NextResponse.json({ deleted: true });
}
