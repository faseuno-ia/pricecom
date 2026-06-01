import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import {
  resolvePricing,
  type PricingRuleForCalc,
} from "@/lib/pricing/pricing-engine";
import { buildCatalogListWhere } from "@/lib/catalog/list-filters";

const MAX_PAGE_SIZE = 500;

export async function GET(req: NextRequest) {
  const session = await requireSession();
  const url = new URL(req.url);

  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(url.searchParams.get("pageSize") ?? "50", 10) || 50)
  );

  const where = buildCatalogListWhere(session.user.id, url.searchParams);

  const [total, products, rules] = await Promise.all([
    prisma.catalogProduct.count({ where }),
    prisma.catalogProduct.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        provider: {
          select: {
            id: true,
            name: true,
            baseUrl: true,
            providerType: true,
            listDiscountPercent: true,
          },
        },
        // isPrimary primero (si está marcada), luego por posición. Cubre el caso
        // en que la imagen primaria no es la de menor `position`.
        images: {
          orderBy: [{ isPrimary: "desc" }, { position: "asc" }],
          take: 1,
          select: { id: true, url: true, isPrimary: true },
        },
        assignedCategory: { select: { id: true, name: true } },
        publications: {
          select: {
            sku: true,
            status: true,
            storeId: true,
            externalProductId: true,
            pendingSync: true,
            syncStatus: true,
          },
        },
      },
    }),
    // Reglas activas del usuario (cargadas una vez, aplicadas en cliente del motor)
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

  const rulesForCalc: PricingRuleForCalc[] = rules;
  const enriched = products.map((p) => {
    const pricing = resolvePricing(
      {
        wholesalePrice: p.wholesalePrice,
        manualMargin: p.manualMargin,
        finalPrice: p.finalPrice,
        assignedCategoryId: p.assignedCategoryId,
        providerId: p.providerId,
        listDiscountPercent: p.provider.listDiscountPercent
          ? Number(p.provider.listDiscountPercent)
          : 0,
      },
      rulesForCalc
    );
    return { ...p, pricing };
  });

  return NextResponse.json({ products: enriched, total, page, pageSize });
}
