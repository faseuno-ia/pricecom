import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import {
  Prisma,
  CatalogProductStatus,
  PublicationStatus,
  InternalPublicationStatus,
  CatalogSourceType,
} from "@prisma/client";
import {
  resolvePricing,
  type PricingRuleForCalc,
} from "@/lib/pricing/pricing-engine";

const VALID_SUPPLIER: CatalogProductStatus[] = [
  "ACTIVE",
  "SUPPLIER_REMOVED",
  "IGNORED",
  "ARCHIVED",
];
const VALID_INTERNAL: InternalPublicationStatus[] = [
  "NOT_PUBLISHED",
  "PREPARED",
  "PAUSED",
  "IGNORED",
  "ARCHIVED",
];
const VALID_PUB: (PublicationStatus | "NONE")[] = [
  "DRAFT",
  "ACTIVE",
  "PAUSED",
  "REMOVED",
  "ERROR",
  "NONE",
];
const VALID_SOURCE: CatalogSourceType[] = ["SCRAPED", "MANUAL", "IMPORTED"];

const MAX_PAGE_SIZE = 100;

export async function GET(req: NextRequest) {
  const session = await requireSession();
  const url = new URL(req.url);

  const search = url.searchParams.get("search")?.trim();
  const providerId = url.searchParams.get("providerId");
  const supplierStatusParam = url.searchParams.get("supplierStatus");
  const internalStatusParam = url.searchParams.get("internalStatus");
  const publicationStatusParam = url.searchParams.get("publicationStatus");
  const sourceTypeParam = url.searchParams.get("sourceType");
  const noImage = url.searchParams.get("noImage") === "true";
  const noCategory = url.searchParams.get("noCategory") === "true";
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, parseInt(url.searchParams.get("pageSize") ?? "50", 10) || 50)
  );

  const where: Prisma.CatalogProductWhereInput = {
    userId: session.user.id,
  };

  if (providerId) where.providerId = providerId;

  if (supplierStatusParam && VALID_SUPPLIER.includes(supplierStatusParam as CatalogProductStatus)) {
    where.supplierStatus = supplierStatusParam as CatalogProductStatus;
  }

  if (
    internalStatusParam &&
    VALID_INTERNAL.includes(internalStatusParam as InternalPublicationStatus)
  ) {
    where.internalStatus = internalStatusParam as InternalPublicationStatus;
  }

  if (
    sourceTypeParam &&
    VALID_SOURCE.includes(sourceTypeParam as CatalogSourceType)
  ) {
    where.sourceType = sourceTypeParam as CatalogSourceType;
  }

  if (
    publicationStatusParam &&
    VALID_PUB.includes(publicationStatusParam as PublicationStatus | "NONE")
  ) {
    if (publicationStatusParam === "NONE") {
      where.publications = { none: {} };
    } else {
      where.publications = {
        some: { status: publicationStatusParam as PublicationStatus },
      };
    }
  }

  if (noImage) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      { OR: [{ imageUrl: null }, { imageUrl: "" }] },
      { images: { none: {} } },
    ];
  }

  if (noCategory) {
    where.assignedCategoryId = null;
  }

  if (search) {
    where.OR = [
      { supplierName: { contains: search, mode: "insensitive" } },
      { commercialTitle: { contains: search, mode: "insensitive" } },
      { commercialName: { contains: search, mode: "insensitive" } },
      { sku: { contains: search, mode: "insensitive" } },
    ];
  }

  const [total, products, rules] = await Promise.all([
    prisma.catalogProduct.count({ where }),
    prisma.catalogProduct.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        provider: { select: { id: true, name: true, baseUrl: true } },
        // isPrimary primero (si está marcada), luego por posición. Cubre el caso
        // en que la imagen primaria no es la de menor `position`.
        images: {
          orderBy: [{ isPrimary: "desc" }, { position: "asc" }],
          take: 1,
          select: { id: true, url: true, isPrimary: true },
        },
        assignedCategory: { select: { id: true, name: true } },
        publications: {
          select: { status: true, storeId: true, externalProductId: true },
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
      },
      rulesForCalc
    );
    return { ...p, pricing };
  });

  return NextResponse.json({ products: enriched, total, page, pageSize });
}
