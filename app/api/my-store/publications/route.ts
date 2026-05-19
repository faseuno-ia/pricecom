// GET /api/my-store/publications
// Devuelve publicaciones del store del usuario con paginación, filtro y búsqueda.
//
// Query params:
//   page (default 1)
//   pageSize (default 50, max 200)
//   filter: ALL | ACTIVE | DRAFT | PAUSED | ERROR | PENDING_SYNC | OUTDATED
//   search: matchea externalSku, catalogProduct.publicationSku, commercialTitle, supplierName

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { Prisma } from "@prisma/client";
import {
  resolvePricing,
  type PricingRuleForCalc,
} from "@/lib/pricing/pricing-engine";

const MAX_PAGE_SIZE = 200;
type Filter =
  | "ALL"
  | "ACTIVE"
  | "DRAFT"
  | "PAUSED"
  | "ERROR"
  | "PENDING_SYNC"
  | "OUTDATED";
const VALID_FILTERS: Filter[] = [
  "ALL",
  "ACTIVE",
  "DRAFT",
  "PAUSED",
  "ERROR",
  "PENDING_SYNC",
  "OUTDATED",
];

export async function GET(req: NextRequest) {
  const session = await requireSession();
  const url = new URL(req.url);

  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(url.searchParams.get("pageSize") ?? "50", 10) || 50)
  );
  const filterParam = (url.searchParams.get("filter") ?? "ALL") as Filter;
  const filter: Filter = VALID_FILTERS.includes(filterParam) ? filterParam : "ALL";
  const search = url.searchParams.get("search")?.trim() ?? "";

  const store = await prisma.store.findFirst({
    where: { userId: session.user.id },
    select: { id: true },
  });
  if (!store) {
    return NextResponse.json({
      publications: [],
      total: 0,
      page,
      pageSize,
    });
  }

  // Construcción de where con AND para combinar filtros + search sin pisarse.
  const andClauses: Prisma.ProductPublicationWhereInput[] = [
    { storeId: store.id },
  ];

  if (filter !== "ALL") {
    if (filter === "PENDING_SYNC") {
      andClauses.push({
        OR: [{ syncStatus: "PENDING_SYNC" }, { pendingSync: true }],
      });
    } else if (filter === "OUTDATED") {
      andClauses.push({ syncStatus: "OUTDATED" });
    } else {
      andClauses.push({ status: filter });
    }
  }

  if (search) {
    andClauses.push({
      OR: [
        { externalSku: { contains: search, mode: "insensitive" } },
        {
          catalogProduct: {
            is: { publicationSku: { contains: search, mode: "insensitive" } },
          },
        },
        {
          catalogProduct: {
            is: { commercialTitle: { contains: search, mode: "insensitive" } },
          },
        },
        {
          catalogProduct: {
            is: { supplierName: { contains: search, mode: "insensitive" } },
          },
        },
        {
          catalogProduct: {
            is: { sku: { contains: search, mode: "insensitive" } },
          },
        },
      ],
    });
  }

  const where: Prisma.ProductPublicationWhereInput = { AND: andClauses };

  const [total, publications, rules] = await Promise.all([
    prisma.productPublication.count({ where }),
    prisma.productPublication.findMany({
      where,
      orderBy: { lastSyncedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        catalogProduct: {
          select: {
            id: true,
            publicationSku: true,
            commercialTitle: true,
            supplierName: true,
            imageUrl: true,
            finalPrice: true,
            stock: true,
            stockSource: true,
            wholesalePrice: true,
            manualMargin: true,
            assignedCategoryId: true,
            providerId: true,
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

  const rulesForCalc: PricingRuleForCalc[] = rules;

  const enriched = publications.map((p) => {
    const pricing = resolvePricing(
      {
        wholesalePrice: p.catalogProduct.wholesalePrice,
        manualMargin: p.catalogProduct.manualMargin,
        finalPrice: p.catalogProduct.finalPrice,
        assignedCategoryId: p.catalogProduct.assignedCategoryId,
        providerId: p.catalogProduct.providerId,
      },
      rulesForCalc
    );
    return {
      id: p.id,
      status: p.status,
      syncStatus: p.syncStatus,
      externalProductId: p.externalProductId,
      externalSku: p.externalSku,
      externalStatus: p.externalStatus,
      externalUrl: p.externalUrl,
      priceInStore: p.priceInStore,
      stockInStore: p.stockInStore,
      categoryInStore: p.categoryInStore,
      lastSyncedAt: p.lastSyncedAt ? p.lastSyncedAt.toISOString() : null,
      pendingSync: p.pendingSync,
      syncError: p.syncError,
      catalogProduct: {
        id: p.catalogProduct.id,
        publicationSku: p.catalogProduct.publicationSku,
        commercialTitle: p.catalogProduct.commercialTitle,
        supplierName: p.catalogProduct.supplierName,
        imageUrl: p.catalogProduct.imageUrl,
        finalPrice: p.catalogProduct.finalPrice,
        stock: p.catalogProduct.stock,
        stockSource: p.catalogProduct.stockSource,
        pricing: { effectivePrice: pricing.effectivePrice },
      },
    };
  });

  return NextResponse.json({
    publications: enriched,
    total,
    page,
    pageSize,
  });
}
