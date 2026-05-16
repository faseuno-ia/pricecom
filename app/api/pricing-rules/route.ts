import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { PricingRuleScope, RoundingMode } from "@prisma/client";
import { z } from "zod";

const SCOPES: PricingRuleScope[] = ["GLOBAL", "PROVIDER", "CATEGORY"];
const ROUNDINGS: RoundingMode[] = ["NONE", "NEAREST_100", "NEAREST_500", "ENDING_990"];

export async function GET() {
  const session = await requireSession();

  const rules = await prisma.pricingRule.findMany({
    where: { userId: session.user.id },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
  });

  // Resolver nombres de scope (providerId/categoryId) en un par de queries
  // para mostrarlos en la UI sin N+1.
  const providerIds = rules
    .filter((r) => r.scope === "PROVIDER" && r.scopeId)
    .map((r) => r.scopeId!);
  const categoryIds = rules
    .filter((r) => r.scope === "CATEGORY" && r.scopeId)
    .map((r) => r.scopeId!);

  const [providers, categories] = await Promise.all([
    providerIds.length
      ? prisma.provider.findMany({
          where: { id: { in: providerIds }, userId: session.user.id },
          select: { id: true, name: true },
        })
      : [],
    categoryIds.length
      ? prisma.category.findMany({
          where: { id: { in: categoryIds } },
          select: { id: true, name: true },
        })
      : [],
  ]);
  const provName = new Map(providers.map((p) => [p.id, p.name]));
  const catName = new Map(categories.map((c) => [c.id, c.name]));

  const enriched = rules.map((r) => ({
    ...r,
    scopeName:
      r.scope === "GLOBAL"
        ? null
        : r.scope === "PROVIDER"
          ? provName.get(r.scopeId ?? "") ?? "(proveedor desconocido)"
          : catName.get(r.scopeId ?? "") ?? "(categoría desconocida)",
  }));

  return NextResponse.json({ rules: enriched });
}

const createSchema = z
  .object({
    name: z.string().min(1).max(80),
    scope: z.enum(SCOPES as [PricingRuleScope]),
    scopeId: z.string().nullable().optional(),
    marginPercent: z.number(),
    roundingMode: z.enum(ROUNDINGS as [RoundingMode]).default("NONE"),
    isActive: z.boolean().default(true),
    priority: z.number().int().default(0),
  })
  .refine((d) => (d.scope === "GLOBAL" ? !d.scopeId : !!d.scopeId), {
    message: "scopeId requerido para PROVIDER/CATEGORY; debe ser null para GLOBAL",
  });

export async function POST(req: NextRequest) {
  const session = await requireSession();

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }

  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validación falló", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  // Si scope=PROVIDER, validar que el provider pertenezca al usuario.
  if (parsed.data.scope === "PROVIDER" && parsed.data.scopeId) {
    const ok = await prisma.provider.findFirst({
      where: { id: parsed.data.scopeId, userId: session.user.id },
      select: { id: true },
    });
    if (!ok) {
      return NextResponse.json(
        { error: "Proveedor no encontrado" },
        { status: 400 }
      );
    }
  }

  const rule = await prisma.pricingRule.create({
    data: {
      userId: session.user.id,
      name: parsed.data.name,
      scope: parsed.data.scope,
      scopeId: parsed.data.scopeId ?? null,
      marginPercent: parsed.data.marginPercent,
      roundingMode: parsed.data.roundingMode,
      isActive: parsed.data.isActive,
      priority: parsed.data.priority,
    },
  });

  return NextResponse.json(rule, { status: 201 });
}
