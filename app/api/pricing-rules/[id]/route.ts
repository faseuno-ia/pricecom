import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { PricingRuleScope, RoundingMode } from "@prisma/client";
import { z } from "zod";
import { markDriftForRuleChange } from "@/lib/catalog/mark-drift-for-rule-change";

export const maxDuration = 60;

const SCOPES: PricingRuleScope[] = ["GLOBAL", "PROVIDER", "CATEGORY"];
const ROUNDINGS: RoundingMode[] = ["NONE", "CEIL", "NEAREST_100", "NEAREST_500", "ENDING_990"];

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
    select: { id: true, scope: true, scopeId: true, name: true, marginPercent: true },
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

  // D1: re-evaluar drift en el scope VIEJO ∪ NUEVO (margen/scope/priority/
  // isActive pueden desincronizar productos de ambos lados). Después del update
  // para que markPublicationsDrift recompute con la regla nueva.
  const drift = await markDriftForRuleChange(prisma, {
    userId: session.user.id,
    ruleId: updated.id,
    action: "updated",
    scopes: [
      { scope: owned.scope, scopeId: owned.scopeId },
      { scope: updated.scope, scopeId: updated.scopeId },
    ],
    ruleName: updated.name,
    marginPercentOld: owned.marginPercent,
    marginPercentNew: updated.marginPercent,
  });

  return NextResponse.json({ ...updated, markedOutdated: drift.markedOutdated });
}

export async function DELETE(
  _: NextRequest,
  { params }: { params: { id: string } }
) {
  const session = await requireSession();

  const owned = await prisma.pricingRule.findFirst({
    where: { id: params.id, userId: session.user.id },
    select: { id: true, scope: true, scopeId: true, name: true, marginPercent: true },
  });
  if (!owned) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // D1: capturar los ids linkeados ANTES del delete (el delete los pone
  // pricingRuleId=null y se perderían).
  const linked = await prisma.catalogProduct.findMany({
    where: { pricingRuleId: params.id },
    select: { id: true },
  });

  // Desvincular CatalogProducts que apuntaban a esta regla (set null en FK).
  await prisma.$transaction([
    prisma.catalogProduct.updateMany({
      where: { pricingRuleId: params.id },
      data: { pricingRuleId: null },
    }),
    prisma.pricingRule.delete({ where: { id: params.id } }),
  ]);

  // D1: marcar drift DESPUÉS del delete — resolvePricing ya no ve la regla.
  const drift = await markDriftForRuleChange(prisma, {
    userId: session.user.id,
    ruleId: params.id,
    action: "deleted",
    scopes: [{ scope: owned.scope, scopeId: owned.scopeId }],
    extraCatalogProductIds: linked.map((c) => c.id),
    ruleName: owned.name,
    marginPercentOld: owned.marginPercent,
  });

  return NextResponse.json({ ok: true, markedOutdated: drift.markedOutdated });
}
