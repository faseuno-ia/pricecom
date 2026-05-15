import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import ExcelJS from "exceljs";
import { format } from "date-fns";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_EXPORT = 5000;

const changeTypeLabel: Record<string, string> = {
  NEW: "Nuevo",
  REMOVED: "Removido",
  PRICE_UP: "Precio subió",
  PRICE_DOWN: "Precio bajó",
  STOCK_CHANGED: "Stock cambió",
};

export async function POST(req: NextRequest) {
  const session = await requireSession();

  let body: { changeIds?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido" }, { status: 400 });
  }

  const ids = body.changeIds;
  if (!Array.isArray(ids) || ids.length === 0) {
    return NextResponse.json({ error: "changeIds requerido" }, { status: 400 });
  }
  if (ids.length > MAX_EXPORT) {
    return NextResponse.json(
      { error: `Máximo ${MAX_EXPORT} cambios por export` },
      { status: 400 }
    );
  }
  if (!ids.every((id) => typeof id === "string")) {
    return NextResponse.json({ error: "IDs deben ser strings" }, { status: 400 });
  }

  // Filtramos por pertenencia del usuario via la cadena de comparison → job.userId.
  const changes = await prisma.productChange.findMany({
    where: {
      id: { in: ids as string[] },
      comparison: { job: { userId: session.user.id } },
    },
    orderBy: { createdAt: "desc" },
    include: {
      comparison: {
        select: {
          jobId: true,
          job: {
            select: { provider: { select: { name: true } } },
          },
        },
      },
    },
  });

  if (changes.length === 0) {
    return NextResponse.json({ error: "Sin cambios para exportar" }, { status: 404 });
  }

  // Enriquecer con ExtractedProduct (categoría + publicationStatus) en un batch.
  const enrichable = changes.filter((c) => c.changeType !== "REMOVED" && c.sku);
  const jobIds = Array.from(new Set(enrichable.map((c) => c.comparison.jobId)));
  const skus = Array.from(
    new Set(enrichable.map((c) => c.sku!).filter((s) => s.length > 0))
  );

  const products =
    jobIds.length > 0 && skus.length > 0
      ? await prisma.extractedProduct.findMany({
          where: { jobId: { in: jobIds }, sku: { in: skus } },
          select: {
            jobId: true,
            sku: true,
            category: true,
            publicationStatus: true,
          },
        })
      : [];
  const productByKey = new Map<
    string,
    { category: string | null; publicationStatus: string | null }
  >();
  for (const p of products) {
    if (p.sku) {
      productByKey.set(`${p.jobId}:${p.sku}`, {
        category: p.category,
        publicationStatus: p.publicationStatus,
      });
    }
  }

  // Generar Excel
  const wb = new ExcelJS.Workbook();
  wb.creator = "PricEcom";
  wb.created = new Date();

  const sheet = wb.addWorksheet("Cambios", {
    views: [{ state: "frozen", ySplit: 1 }],
  });
  sheet.columns = [
    { header: "Proveedor", key: "providerName", width: 22 },
    { header: "Tipo cambio", key: "changeType", width: 16 },
    { header: "SKU", key: "sku", width: 18 },
    { header: "Nombre", key: "name", width: 45 },
    { header: "Categoría", key: "category", width: 22 },
    { header: "Precio anterior", key: "previousPrice", width: 16 },
    { header: "Precio actual", key: "currentPrice", width: 16 },
    { header: "Δ%", key: "priceChangePercent", width: 10 },
    { header: "Stock anterior", key: "previousStock", width: 14 },
    { header: "Stock actual", key: "currentStock", width: 14 },
    { header: "Fecha", key: "createdAt", width: 18 },
    { header: "Estado publicación", key: "publicationStatus", width: 18 },
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

  for (const c of changes) {
    const enrich = c.sku
      ? productByKey.get(`${c.comparison.jobId}:${c.sku}`)
      : undefined;
    sheet.addRow({
      providerName: c.comparison.job.provider.name,
      changeType: changeTypeLabel[c.changeType] ?? c.changeType,
      sku: c.sku ?? "",
      name: c.name,
      category: enrich?.category ?? "",
      previousPrice: c.previousPrice != null ? Number(c.previousPrice) : null,
      currentPrice: c.currentPrice != null ? Number(c.currentPrice) : null,
      priceChangePercent:
        c.priceChangePercent != null ? Number(c.priceChangePercent) : null,
      previousStock: c.previousStock ?? "",
      currentStock: c.currentStock ?? "",
      createdAt: format(new Date(c.createdAt), "dd/MM/yyyy HH:mm"),
      publicationStatus: enrich?.publicationStatus ?? "",
    });
  }

  // Format precio columns
  sheet.getColumn("previousPrice").numFmt = '"$"#,##0.00';
  sheet.getColumn("currentPrice").numFmt = '"$"#,##0.00';
  sheet.getColumn("priceChangePercent").numFmt = "0.00";

  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 12 } };

  const buffer = await wb.xlsx.writeBuffer();
  const filename = `cambios-pricecom-${format(new Date(), "yyyyMMdd-HHmm")}.xlsx`;

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
