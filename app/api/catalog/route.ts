import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { Prisma, CatalogProductStatus, PublicationStatus } from "@prisma/client";

const VALID_SUPPLIER: CatalogProductStatus[] = [
  "ACTIVE",
  "SUPPLIER_REMOVED",
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

const MAX_PAGE_SIZE = 100;

export async function GET(req: NextRequest) {
  const session = await requireSession();
  const url = new URL(req.url);

  const search = url.searchParams.get("search")?.trim();
  const providerId = url.searchParams.get("providerId");
  const supplierStatusParam = url.searchParams.get("supplierStatus");
  const publicationStatusParam = url.searchParams.get("publicationStatus");
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

  const [total, products] = await Promise.all([
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
  ]);

  return NextResponse.json({ products, total, page, pageSize });
}
