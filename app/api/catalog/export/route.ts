import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import type { Prisma } from "@prisma/client";
import ExcelJS from "exceljs";
import { format } from "date-fns";
import { z } from "zod";
import {
  resolvePricing,
  type PricingRuleForCalc,
} from "@/lib/pricing/pricing-engine";
import { buildCatalogListWhere } from "@/lib/catalog/list-filters";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_EXPORT = 10_000;

// Schema laxo: aceptamos todos los filtros del listado como strings/booleans
// opcionales. La validación fina (qué valores son válidos para cada enum)
// vive en buildCatalogListWhere — esa es nuestra fuente única de verdad para
// los filtros del catálogo.
const filtersSchema = z
  .object({
    search: z.string().optional(),
    providerId: z.string().optional(),
    supplierStatus: z.string().optional(),
    internalStatus: z.string().optional(),
    visualStatus: z.string().optional(),
    publicationStatus: z.string().optional(),
    stockSource: z.string().optional(),
    sourceType: z.string().optional(),
    noImage: z.boolean().optional(),
    noCategory: z.boolean().optional(),
    showRemovedIgnored: z.boolean().optional(),
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

// Convierte el objeto de filtros (JSON) a URLSearchParams para reusar el
// builder de list-filters.ts sin duplicar lógica.
function filtersToSearchParams(
  filters: z.infer<typeof filtersSchema>
): URLSearchParams {
  const params = new URLSearchParams();
  if (!filters) return params;
  if (filters.search?.trim()) params.set("search", filters.search.trim());
  if (filters.providerId) params.set("providerId", filters.providerId);
  if (filters.supplierStatus)
    params.set("supplierStatus", filters.supplierStatus);
  if (filters.internalStatus)
    params.set("internalStatus", filters.internalStatus);
  if (filters.visualStatus) params.set("visualStatus", filters.visualStatus);
  if (filters.publicationStatus)
    params.set("publicationStatus", filters.publicationStatus);
  if (filters.stockSource) params.set("stockSource", filters.stockSource);
  if (filters.sourceType) params.set("sourceType", filters.sourceType);
  if (filters.noImage) params.set("noImage", "true");
  if (filters.noCategory) params.set("noCategory", "true");
  if (filters.showRemovedIgnored) params.set("showRemovedIgnored", "true");
  return params;
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

  const where: Prisma.CatalogProductWhereInput = parsed.data.catalogProductIds
    ?.length
    ? { id: { in: parsed.data.catalogProductIds }, userId: session.user.id }
    : buildCatalogListWhere(
        session.user.id,
        filtersToSearchParams(parsed.data.filters)
      );

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
        provider: { select: { listDiscountPercent: true } },
        images: {
          orderBy: [{ isPrimary: "desc" }, { position: "asc" }],
          take: 1,
          select: { url: true },
        },
        // Fase 4A: SKU comercial canónico desde pp.sku (en lugar de
        // CatalogProduct.publicationSku). Para 1 store por user hay 0-1
        // publications; tomamos la primera.
        publications: {
          select: { sku: true },
          take: 1,
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
    { header: "SKU comercial", key: "publicationSku", width: 18 },
    { header: "SKU Proveedor", key: "sku", width: 14 },
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
        listDiscountPercent: p.provider.listDiscountPercent
          ? Number(p.provider.listDiscountPercent)
          : 0,
      },
      rulesForCalc
    );
    const price = p.finalPrice ?? pricing.calculatedPrice ?? "";

    sheet.addRow({
      // Read-only: vuelca lo que hay en DB. SKU comercial = pp.sku (canónico
      // post-Fase 3 lazy). Vacío si no tiene publication o pub.sku=null
      // (coherente con el "—" del catálogo). El sku raw del proveedor se
      // exporta aparte en su propia columna.
      publicationSku: p.publications[0]?.sku ?? "",
      sku: p.sku ?? "",
      title: p.commercialTitle ?? p.supplierName ?? "",
      price,
      category: p.assignedCategory?.name ?? p.supplierCategory ?? "",
      image: p.images[0]?.url ?? p.imageUrl ?? "",
    });
  }

  sheet.getColumn("price").numFmt = '"$"#,##0.00';

  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 6 } };

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
