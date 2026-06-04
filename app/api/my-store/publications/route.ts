// GET /api/my-store/publications
// Devuelve publicaciones del store del usuario con paginación, filtro y búsqueda.
//
// Query params:
//   page (default 1)
//   pageSize (default 50, max 200)
//   filter: ALL | ACTIVE | DRAFT | PAUSED | ERROR | PENDING_SYNC | OUTDATED | SIN_STOCK
//   search: matchea externalSku, catalogProduct.publicationSku, commercialTitle, supplierName
//
// Semántica de los filtros que comparten "drift":
//   PENDING_SYNC  → acciones de sistema pendientes (auto-pausa, alta nueva).
//                   Filtra estrictamente syncStatus=PENDING_SYNC. NO incluye
//                   las OUTDATED aunque también tengan pendingSync=true.
//   OUTDATED      → drift de precio entre PricEcom y la tienda externa.
//   PAUSED        → pausa manual real (cp.internalStatus=PAUSED + pausedBySystem=false).
//                   Alineado con el KPI "Pausados" del dashboard. Los IGNORED y
//                   PREPARED ya NO entran acá (tienen su propia semántica); los
//                   auto-pausados por SUPPLIER_REMOVED entran en SIN_STOCK.
//   SIN_STOCK     → catalogProduct.supplierStatus = SUPPLIER_REMOVED,
//                   independiente del estado interno.

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
  | "SIN_STOCK"
  | "ERROR"
  | "PENDING_SYNC"
  | "OUTDATED";
const VALID_FILTERS: Filter[] = [
  "ALL",
  "ACTIVE",
  "DRAFT",
  "PAUSED",
  "SIN_STOCK",
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
  // Toggle de Ignorados: por default, las publicaciones cuyo cp.internalStatus
  // es IGNORED no se listan (decisión comercial duradera del usuario, no
  // requieren atención cotidiana). Con includeIgnored=true se muestran.
  // Mismo patrón que "Ver descartados manualmente" de Unmatched.
  const includeIgnored =
    url.searchParams.get("includeIgnored") === "true";

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

  if (!includeIgnored) {
    andClauses.push({
      catalogProduct: { is: { internalStatus: { not: "IGNORED" } } },
    });
  }

  if (filter !== "ALL") {
    if (filter === "PENDING_SYNC") {
      // Estrictamente acciones de sistema pendientes (no OUTDATED, aunque
      // ambos compartan pendingSync=true).
      andClauses.push({ syncStatus: "PENDING_SYNC" });
    } else if (filter === "OUTDATED") {
      andClauses.push({ syncStatus: "OUTDATED" });
    } else if (filter === "PAUSED") {
      // Pausa manual estricta, alineada con el KPI "Pausados" del dashboard:
      // cp.internalStatus=PAUSED + pausedBySystem=false. Antes el filtro miraba
      // pp.status=PAUSED, que incluía silenciosamente IGNORED y PREPARED
      // (ambos terminan en pp.status=PAUSED tras pauseProductInWoo). Ahora
      // cada balde tiene su propia métrica de intención.
      andClauses.push({
        catalogProduct: {
          is: { internalStatus: "PAUSED", pausedBySystem: false },
        },
      });
    } else if (filter === "SIN_STOCK") {
      // El proveedor removió el producto, independiente del estado interno.
      andClauses.push({
        catalogProduct: { is: { supplierStatus: "SUPPLIER_REMOVED" } },
      });
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
            internalStatus: true,
            supplierStatus: true,
            provider: { select: { listDiscountPercent: true } },
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
        listDiscountPercent: p.catalogProduct.provider?.listDiscountPercent
          ? Number(p.catalogProduct.provider.listDiscountPercent)
          : 0,
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
        internalStatus: p.catalogProduct.internalStatus,
        supplierStatus: p.catalogProduct.supplierStatus,
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
