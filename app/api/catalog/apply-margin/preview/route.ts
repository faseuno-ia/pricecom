import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { RoundingMode } from "@prisma/client";
import { applyMarkup } from "@/lib/pricing/pricing-engine";
import { buildApplyMarginWhere } from "@/lib/catalog/apply-margin-where";
import { z } from "zod";

const ROUNDINGS: RoundingMode[] = ["NONE", "NEAREST_100", "NEAREST_500", "ENDING_990"];

const bodySchema = z.object({
  productIds: z.array(z.string()).optional(),
  providerId: z.string().optional(),
  categoryId: z.string().optional(),
  applyAll: z.boolean().optional(),
  marginPercent: z.number(),
  roundingMode: z.enum(ROUNDINGS as [RoundingMode]).default("NONE"),
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

  const totalProducts = await prisma.catalogProduct.count({ where });

  if (totalProducts === 0) {
    return NextResponse.json({
      totalProducts: 0,
      avgCost: null,
      avgCurrentPrice: null,
      avgNewPrice: null,
      examples: [],
    });
  }

  const products = await prisma.catalogProduct.findMany({
    where,
    select: {
      id: true,
      sku: true,
      supplierName: true,
      commercialTitle: true,
      wholesalePrice: true,
      finalPrice: true,
      manualPrice: true,
    },
  });

  const withCost = products.filter((p) => p.wholesalePrice != null && p.wholesalePrice > 0);
  const avg = (vals: number[]) =>
    vals.length === 0 ? null : Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 100) / 100;

  const avgCost = avg(withCost.map((p) => Number(p.wholesalePrice)));
  const currentPrices = products
    .map((p) => p.finalPrice ?? p.manualPrice ?? null)
    .filter((v): v is number => v != null);
  const avgCurrentPrice = avg(currentPrices);
  const newPrices = withCost.map((p) =>
    applyMarkup(Number(p.wholesalePrice), parsed.data.marginPercent, parsed.data.roundingMode)
  );
  const avgNewPrice = avg(newPrices);

  const examples = withCost.slice(0, 5).map((p) => {
    const cost = Number(p.wholesalePrice);
    const newPrice = applyMarkup(cost, parsed.data.marginPercent, parsed.data.roundingMode);
    return {
      id: p.id,
      sku: p.sku,
      name: p.commercialTitle?.trim() || p.supplierName,
      cost,
      marginPercent: parsed.data.marginPercent,
      newPrice,
    };
  });

  return NextResponse.json({
    totalProducts,
    avgCost,
    avgCurrentPrice,
    avgNewPrice,
    examples,
  });
}
