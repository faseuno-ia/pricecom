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
import {
  resolvePricing,
  type PricingRuleForCalc,
} from "@/lib/pricing/pricing-engine";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_EXPORT = 10_000;

const VALID_SUPPLIER: CatalogProductStatus[] = ["ACTIVE", "SUPPLIER_REMOVED"];
const VALID_INTERNAL: InternalPublicationStatus[] = [
  "NOT_PUBLISHED",
  "PREPARED",
  "PUBLISHED",
  "PAUSED",
  "IGNORED",
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

  const [products, rules] = await Promise.all([
    prisma.catalogProduct.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      include: {
        assignedCategory: { select: { name: true } },
        images: {
          orderBy: [{ isPrimary: "desc" }, { position: "asc" }],
          take: 1,
          select: { url: true },
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

  const wb = new ExcelJS.Workbook();
  wb.creator = "PricEcom";
  wb.created = new Date();
  const sheet = wb.addWorksheet("Catálogo", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  sheet.columns = [
    { header: "SKU", key: "publicationSku", width: 18 },
    { header: "Descripción", key: "title", width: 50 },
    { header: "Precio", key: "price", width: 15 },
    { header: "Categoría", key: "category", width: 25 },
    { header: "Imagen", key: "image", width: 60 },
  ] as Partial<ExcelJS.Column>[];

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
    const price = p.finalPrice ?? pricing.calculatedPrice ?? "";

    sheet.addRow({
      publicationSku: p.publicationSku ?? p.sku ?? "",
      title: p.commercialTitle ?? p.supplierName ?? "",
      price,
      category: p.assignedCategory?.name ?? p.supplierCategory ?? "",
      image: p.images[0]?.url ?? p.imageUrl ?? "",
    });
  }

  sheet.getColumn("price").numFmt = '"$"#,##0.00';

  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 5 } };

  const buffer = await wb.xlsx.writeBuffer();
  const filename = `catalogo-comercial-${format(new Date(), "yyyyMMdd-HHmm")}.xlsx`;

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
