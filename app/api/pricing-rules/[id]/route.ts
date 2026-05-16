import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { PricingRuleScope, RoundingMode } from "@prisma/client";
import { z } from "zod";

const SCOPES: PricingRuleScope[] = ["GLOBAL", "PROVIDER", "CATEGORY"];
const ROUNDINGS: RoundingMode[] = ["NONE", "NEAREST_100", "NEAREST_500", "ENDING_990"];

const patchSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  scope: z.enum(SCOPES as [PricingRuleScope]).optional(),
  scopeId: z.string().nullable().optional(),
  marginPercent: z.number().optional(),
  roundingMode: z.enum(ROUNDINGS as [RoundingMode]).optional(),
  isActive: z.boolean().optional(),
  priority: z.number().int().optional(),
});

export async function PATCH(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await requireSession();

  const owned = await prisma.pricingRule.findFirst({
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

  if (parsed.data.scope === "PROVIDER" && parsed.data.scopeId) {
    const ok = await prisma.provider.findFirst({
      where: { id: parsed.data.scopeId, userId: session.user.id },
      select: { id: true },
    });
    if (!ok) {
      return NextResponse.json({ error: "Proveedor no encontrado" }, { status: 400 });
    }
  }

  const updated = await prisma.pricingRule.update({
    where: { id: params.id },
    data: parsed.data,
  });

  return NextResponse.json(updated);
}

export async function DELETE(
  _: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await requireSession();

  const owned = await prisma.pricingRule.findFirst({
    where: { id: params.id, userId: session.user.id },
    select: { id: true },
  });
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // Desvincular CatalogProducts que apuntaban a esta regla (set null en FK).
  await prisma.$transaction([
    prisma.catalogProduct.updateMany({
      where: { pricingRuleId: params.id },
      data: { pricingRuleId: null },
    }),
    prisma.pricingRule.delete({ where: { id: params.id } }),
  ]);

  return NextResponse.json({ ok: true });
}
