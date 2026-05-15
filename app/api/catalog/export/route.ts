import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import {
  Prisma,
  CatalogProductStatus,
  InternalPublicationStatus,
} from "@prisma/client";
import ExcelJS from "exceljs";
import { format } from "date-fns";
import { z } from "zod";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_EXPORT = 10_000;

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

const filtersSchema = z
  .object({
    providerId: z.string().optional(),
    supplierStatus: z.enum(VALID_SUPPLIER as [CatalogProductStatus]).optional(),
    internalStatus: z
      .enum(VALID_INTERNAL as [InternalPublicationStatus])
      .optional(),
    noImage: z.boolean().optional(),
    noCategory: z.boolean().optional(),
    search: z.string().optional(),
  })
  .optional();

const bodySchema = z
  .object({
    catalogProductIds: z.array(z.string()).optional(),
    filters: filtersSchema,
  })
  .refine(
    (b) => (b.catalogProductIds?.length ?? 0) > 0 || b.filters !== undefined,
    { message: "Se requiere catalogProductIds o filters" }
  );

// Colores (ARGB) por estado, aplicados a la fila completa.
const SUPPLIER_ROW_COLOR: Partial<Record<CatalogProductStatus, string>> = {
  SUPPLIER_REMOVED: "FFFFF0F0",
  IGNORED: "FFF5F5F5",
  ARCHIVED: "FFEEEEEE",
};
const INTERNAL_ROW_COLOR: Partial<Record<InternalPublicationStatus, string>> = {
  PREPARED: "FFF0FFF4",
  PAUSED: "FFFFFBEB",
};

const supplierLabel: Record<CatalogProductStatus, string> = {
  ACTIVE: "Activo",
  SUPPLIER_REMOVED: "Removido por proveedor",
  IGNORED: "Ignorado",
  ARCHIVED: "Archivado",
};
const internalLabel: Record<InternalPublicationStatus, string> = {
  NOT_PUBLISHED: "Sin publicar",
  PREPARED: "Preparado",
  PAUSED: "Pausado",
  IGNORED: "Ignorado",
  ARCHIVED: "Archivado",
};

function buildWhere(
  userId: string,
  filters: z.infer<typeof filtersSchema>
): Prisma.CatalogProductWhereInput {
  const where: Prisma.CatalogProductWhereInput = { userId };
  if (!filters) return where;
  if (filters.providerId) where.providerId = filters.providerId;
  if (filters.supplierStatus) where.supplierStatus = filters.supplierStatus;
  if (filters.internalStatus) where.internalStatus = filters.internalStatus;
  if (filters.noImage) {
    where.AND = [
      { OR: [{ imageUrl: null }, { imageUrl: "" }] },
      { images: { none: {} } },
    ];
  }
  if (filters.noCategory) where.assignedCategoryId = null;
  if (filters.search?.trim()) {
    const s = filters.search.trim();
    where.OR = [
      { supplierName: { contains: s, mode: "insensitive" } },
      { commercialTitle: { contains: s, mode: "insensitive" } },
      { commercialName: { contains: s, mode: "insensitive" } },
      { sku: { contains: s, mode: "insensitive" } },
    ];
  }
  return where;
}

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

  const where = parsed.data.catalogProductIds?.length
    ? { id: { in: parsed.data.catalogProductIds }, userId: session.user.id }
    : buildWhere(session.user.id, parsed.data.filters);

  const total = await prisma.catalogProduct.count({ where });
  if (total === 0) {
    return NextResponse.json({ error: "Sin productos para exportar" }, { status: 404 });
  }
  if (total > MAX_EXPORT) {
    return NextResponse.json(
      { error: `Máximo ${MAX_EXPORT} productos por export (encontrados: ${total}).` },
      { status: 400 }
    );
  }

  const products = await prisma.catalogProduct.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    include: {
      provider: { select: { name: true } },
      assignedCategory: { select: { name: true } },
    },
  });

  const wb = new ExcelJS.Workbook();
  wb.creator = "PricEcom";
  wb.created = new Date();
  const sheet = wb.addWorksheet("Catálogo", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = [
    { header: "SKU", key: "sku", width: 18 },
    { header: "Título comercial", key: "commercialTitle", width: 40 },
    { header: "Nombre proveedor", key: "supplierName", width: 40 },
    { header: "Proveedor", key: "providerName", width: 20 },
    { header: "Costo mayorista", key: "wholesalePrice", width: 16 },
    { header: "Precio final", key: "finalPrice", width: 16 },
    { header: "Margen %", key: "marginPct", width: 12 },
    { header: "Stock", key: "stock", width: 14 },
    { header: "Categoría", key: "category", width: 22 },
    { header: "Estado proveedor", key: "supplierStatus", width: 20 },
    { header: "Estado interno", key: "internalStatus", width: 16 },
    { header: "URL proveedor", key: "productUrl", width: 36 },
    { header: "Imagen URL", key: "imageUrl", width: 36 },
    { header: "Última vez visto", key: "lastSeenAt", width: 18 },
  ] as Partial<ExcelJS.Column>[];

  // Header styling
  const header = sheet.getRow(1);
  header.height = 22;
  header.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1E3A5F" },
    };
    cell.alignment = { vertical: "middle", horizontal: "center" };
  });

  for (const p of products) {
    const wholesale = p.wholesalePrice ?? null;
    const finalP = p.finalPrice ?? p.manualPrice ?? null;
    const margin =
      wholesale != null && wholesale > 0 && finalP != null
        ? Math.round(((finalP - wholesale) / wholesale) * 1000) / 10
        : null;

    const row = sheet.addRow({
      sku: p.sku ?? "",
      commercialTitle: p.commercialTitle ?? "",
      supplierName: p.supplierName,
      providerName: p.provider.name,
      wholesalePrice: wholesale,
      finalPrice: finalP,
      marginPct: margin,
      stock: p.stock ?? "",
      category: p.assignedCategory?.name ?? p.supplierCategory ?? "",
      supplierStatus: supplierLabel[p.supplierStatus],
      internalStatus: internalLabel[p.internalStatus],
      productUrl: p.productUrl ?? "",
      imageUrl: p.imageUrl ?? "",
      lastSeenAt: format(new Date(p.lastSeenAt), "dd/MM/yyyy HH:mm"),
    });

    // Color de fila: precedencia internalStatus (PREPARED/PAUSED) sobre supplier;
    // si ninguno aplica color especial, queda blanco.
    const color =
      INTERNAL_ROW_COLOR[p.internalStatus] ??
      SUPPLIER_ROW_COLOR[p.supplierStatus];
    if (color) {
      row.eachCell((cell) => {
        cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: color } };
      });
    }
  }

  // Format precio columns
  sheet.getColumn("wholesalePrice").numFmt = '"$"#,##0.00';
  sheet.getColumn("finalPrice").numFmt = '"$"#,##0.00';
  sheet.getColumn("marginPct").numFmt = "0.0";

  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 14 } };

  const buffer = await wb.xlsx.writeBuffer();
  const filename = `catalogo-pricecom-${format(new Date(), "yyyyMMdd-HHmm")}.xlsx`;

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(buffer.byteLength),
    },
  });
}
