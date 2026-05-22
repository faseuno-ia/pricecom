import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { RoundingMode } from "@prisma/client";
import { applyMarkup } from "@/lib/pricing/pricing-engine";
import { buildApplyMarginWhere } from "@/lib/catalog/apply-margin-where";
import { markPublicationsDrift } from "@/lib/catalog/mark-publications-drift";
import { z } from "zod";

const ROUNDINGS: RoundingMode[] = ["NONE", "NEAREST_100", "NEAREST_500", "ENDING_990"];

const bodySchema = z.object({
  productIds: z.array(z.string()).optional(),
  providerId: z.string().optional(),
  categoryId: z.string().optional(),
  applyAll: z.boolean().optional(),
  marginPercent: z.number(),
  roundingMode: z.enum(ROUNDINGS as [RoundingMode]).default("NONE"),
  overwriteFinalPrice: z.boolean().default(false),
});

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

  const where = buildApplyMarginWhere(session.user.id, parsed.data);
  if (!where) {
    return NextResponse.json(
      { error: "Especificá productIds, providerId, categoryId o applyAll" },
      { status: 400 }
    );
  }

  // Update masivo de manualMargin. Si overwriteFinalPrice=true también recalculamos
  // finalPrice con el costo actual de cada producto (precio "cristalizado"). Si no,
  // dejamos finalPrice intacto y el motor de pricing lo derivará en runtime.
  if (parsed.data.overwriteFinalPrice) {
    // Necesitamos costo por producto → no podemos hacerlo en un updateMany.
    const targets = await prisma.catalogProduct.findMany({
      where,
      select: { id: true, wholesalePrice: true },
    });
    let updated = 0;
    for (const p of targets) {
      const cost = p.wholesalePrice != null ? Number(p.wholesalePrice) : null;
      const newPrice =
        cost != null && cost > 0
          ? applyMarkup(cost, parsed.data.marginPercent, parsed.data.roundingMode)
          : null;
      await prisma.catalogProduct.update({
        where: { id: p.id },
        data: {
          manualMargin: parsed.data.marginPercent,
          ...(newPrice != null ? { finalPrice: newPrice } : {}),
        },
      });
      updated++;
    }
    // Drift: cambio masivo de margen + precio → publications ACTIVE quedan
    // OUTDATED.
    await markPublicationsDrift(
      prisma,
      targets.map((t) => t.id)
    );
    return NextResponse.json({ updated });
  }

  // Necesitamos los ids para el drift (updateMany no los devuelve).
  const targets = await prisma.catalogProduct.findMany({
    where,
    select: { id: true },
  });
  const result = await prisma.catalogProduct.updateMany({
    where: { id: { in: targets.map((t) => t.id) } },
    data: { manualMargin: parsed.data.marginPercent },
  });
  await markPublicationsDrift(
    prisma,
    targets.map((t) => t.id)
  );
  return NextResponse.json({ updated: result.count });
}
