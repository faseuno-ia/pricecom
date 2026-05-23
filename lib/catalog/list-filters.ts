// Builder compartido del `where` de CatalogProduct para los endpoints de
// listado. Usado por /api/catalog (paginado, con datos) y /api/catalog/ids
// (solo IDs para "seleccionar todos del filtro").

import type {
  Prisma,
  CatalogProductStatus,
  PublicationStatus,
  InternalPublicationStatus,
  CatalogSourceType,
  StockSource,
} from "@prisma/client";
import type { VisualStatus } from "./visual-status";

const VALID_SUPPLIER: CatalogProductStatus[] = ["ACTIVE", "SUPPLIER_REMOVED"];
const VALID_INTERNAL: InternalPublicationStatus[] = [
  "NOT_PUBLISHED",
  "PREPARED",
  "PUBLISHED",
  "PAUSED",
  "IGNORED",
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
const VALID_STOCK_SOURCE: StockSource[] = ["SUPPLIER", "OWN", "HYBRID"];
const VALID_VISUAL: VisualStatus[] = [
  "NOT_PUBLISHED",
  "PREPARED",
  "PUBLISHED",
  "OUTDATED",
  "SIN_STOCK",
  "PAUSED",
  "IGNORED",
];

// Traduce un VisualStatus al fragmento de Prisma where correspondiente.
// Cada estado visual deriva de combinaciones específicas de internalStatus +
// supplierStatus + estado de sync de las publications. Mantener acá la
// fuente de verdad evita que UI y backend diverjan.
function visualStatusToWhere(
  s: VisualStatus
): Prisma.CatalogProductWhereInput {
  switch (s) {
    case "NOT_PUBLISHED":
      return { internalStatus: "NOT_PUBLISHED" };
    case "PREPARED":
      return {
        internalStatus: "PREPARED",
        supplierStatus: { not: "SUPPLIER_REMOVED" },
      };
    case "PUBLISHED":
      return {
        internalStatus: "PUBLISHED",
        supplierStatus: { not: "SUPPLIER_REMOVED" },
        publications: { none: { pendingSync: true } },
      };
    case "OUTDATED":
      return {
        internalStatus: "PUBLISHED",
        publications: { some: { pendingSync: true } },
      };
    case "SIN_STOCK":
      return {
        supplierStatus: "SUPPLIER_REMOVED",
        internalStatus: { notIn: ["PAUSED", "IGNORED"] },
      };
    case "PAUSED":
      return { internalStatus: "PAUSED" };
    case "IGNORED":
      return { internalStatus: "IGNORED" };
  }
}

export function buildCatalogListWhere(
  userId: string,
  params: URLSearchParams
): Prisma.CatalogProductWhereInput {
  const search = params.get("search")?.trim();
  const providerId = params.get("providerId");
  const supplierStatusParam = params.get("supplierStatus");
  const internalStatusParam = params.get("internalStatus");
  const publicationStatusParam = params.get("publicationStatus");
  const visualStatusParam = params.get("visualStatus");
  const sourceTypeParam = params.get("sourceType");
  const stockSourceParam = params.get("stockSource");
  const noImage = params.get("noImage") === "true";
  const noCategory = params.get("noCategory") === "true";
  const showRemovedIgnored = params.get("showRemovedIgnored") === "true";

  const visualStatus =
    visualStatusParam && VALID_VISUAL.includes(visualStatusParam as VisualStatus)
      ? (visualStatusParam as VisualStatus)
      : null;

  const where: Prisma.CatalogProductWhereInput = { userId };

  // Por defecto ocultamos:
  //   - productos ignorados (acción del usuario)
  //   - productos removidos por proveedor SOLO si dependen del proveedor
  //     (stockSource=SUPPLIER). OWN/HYBRID sobreviven y siguen visibles.
  // Si el usuario activa showRemovedIgnored, vemos todo. Si pide explícitamente
  // un supplierStatus o internalStatus desde el dropdown, respetamos esa elección.
  if (!showRemovedIgnored) {
    const notClauses: Prisma.CatalogProductWhereInput[] = [];
    // Si el usuario filtra por stock propio, asumimos que quiere ver TODO lo
    // que marcó como OWN — incluyendo los ignorados — porque la marca de
    // stock propio fue una decisión explícita posterior a ignorar. Lo mismo
    // si filtra explícitamente por un visualStatus (SIN_STOCK, IGNORED, etc).
    if (
      !internalStatusParam &&
      stockSourceParam !== "OWN" &&
      !visualStatus
    ) {
      notClauses.push({ internalStatus: "IGNORED" });
    }
    if (!supplierStatusParam && !visualStatus) {
      notClauses.push({
        AND: [
          { supplierStatus: "SUPPLIER_REMOVED" },
          { stockSource: "SUPPLIER" },
        ],
      });
    }
    if (notClauses.length > 0) where.NOT = notClauses;
  }

  if (providerId) where.providerId = providerId;

  if (
    supplierStatusParam &&
    VALID_SUPPLIER.includes(supplierStatusParam as CatalogProductStatus)
  ) {
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
    stockSourceParam &&
    VALID_STOCK_SOURCE.includes(stockSourceParam as StockSource)
  ) {
    where.stockSource = stockSourceParam as StockSource;
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

  // Filtro unificado por estado visual. Mergea con los AND ya existentes
  // (noImage, etc.) para no pisar otros filtros.
  if (visualStatus) {
    const fragment = visualStatusToWhere(visualStatus);
    const existingAnd = Array.isArray(where.AND)
      ? where.AND
      : where.AND
        ? [where.AND]
        : [];
    where.AND = [...existingAnd, fragment];
  }

  if (noImage) {
    where.AND = [
      ...(Array.isArray(where.AND) ? where.AND : where.AND ? [where.AND] : []),
      { OR: [{ imageUrl: null }, { imageUrl: "" }] },
      { images: { none: {} } },
    ];
  }

  if (noCategory) {
    // "Sin categoría" ahora considera la M2M: aplica solo si NO hay ningún
    // CatalogProductCategory **y** assignedCategoryId está null (que debería
    // estar sincronizado por syncPrimaryCategory, pero lo chequeamos doble
    // por las dudas).
    where.assignedCategoryId = null;
    where.categories = { none: {} };
  }

  if (search) {
    where.OR = [
      { supplierName: { contains: search, mode: "insensitive" } },
      { commercialTitle: { contains: search, mode: "insensitive" } },
      { commercialName: { contains: search, mode: "insensitive" } },
      { sku: { contains: search, mode: "insensitive" } },
      { publicationSku: { contains: search, mode: "insensitive" } },
    ];
  }

  return where;
}
