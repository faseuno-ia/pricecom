import ExcelJS from "exceljs";
import path from "path";
import fs from "fs/promises";
import { ExtractedProduct, Provider } from "@prisma/client";
import { format } from "date-fns";
import { es } from "date-fns/locale";

interface ExcelProduct extends ExtractedProduct {
  provider?: Provider | null;
}

export interface ExcelResult {
  /** Ruta absoluta en disco: /proyecto/exports/archivo.xlsx */
  filePath: string;
  /** URL relativa para descarga pública: /exports/archivo.xlsx */
  fileUrl: string;
}

/**
 * Genera el archivo Excel y lo guarda en /exports (carpeta local, no public/).
 * Si la carpeta no existe la crea automáticamente.
 */
export async function generateExcel(
  products: ExcelProduct[],
  provider: Provider,
  jobId: string
): Promise<ExcelResult> {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "PricEcom";
  workbook.created = new Date();

  // ── Hoja Productos ──────────────────────────────────────────────
  const sheet = workbook.addWorksheet("Productos", {
    views: [{ state: "frozen", ySplit: 1 }],
  });

  // Partial<Column>: ExcelJS espera definiciones parciales al setear sheet.columns;
  // los campos completos (style, values, outlineLevel, etc.) se rellenan internamente.
  const columns: Partial<ExcelJS.Column>[] = [
    { header: "SKU", key: "sku", width: 18 },
    { header: "Nombre", key: "name", width: 45 },
    { header: "Descripción", key: "description", width: 55 },
    { header: "Precio Mayorista", key: "wholesalePrice", width: 20 },
    { header: "Precio Anterior", key: "oldPrice", width: 18 },
    { header: "Stock", key: "stock", width: 15 },
    { header: "Categoría", key: "category", width: 22 },
    { header: "Marca", key: "brand", width: 18 },
    { header: "URL Producto", key: "productUrl", width: 40 },
    { header: "URL Imagen", key: "imageUrl", width: 40 },
    { header: "Proveedor", key: "providerName", width: 22 },
    { header: "Fecha Extracción", key: "extractedAt", width: 20 },
    { header: "Estado", key: "status", width: 14 },
    { header: "Observaciones", key: "observations", width: 30 },
  ];

  sheet.columns = columns;

  // Header styling
  const headerRow = sheet.getRow(1);
  headerRow.height = 24;
  headerRow.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: "FFFFFFFF" }, size: 11 };
    cell.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FF1E3A5F" },
    };
    cell.alignment = { vertical: "middle", horizontal: "center", wrapText: false };
    cell.border = {
      bottom: { style: "medium", color: { argb: "FF2D6A4F" } },
    };
  });

  // Add rows
  products.forEach((product, idx) => {
    const row = sheet.addRow({
      sku: product.sku ?? "",
      name: product.name,
      description: product.description ?? "",
      wholesalePrice: product.wholesalePrice ? Number(product.wholesalePrice) : null,
      oldPrice: product.oldPrice ? Number(product.oldPrice) : null,
      stock: product.stock ?? "",
      category: product.category ?? "",
      brand: product.brand ?? "",
      productUrl: product.productUrl ?? "",
      imageUrl: product.imageUrl ?? "",
      providerName: provider.name,
      extractedAt: format(new Date(product.extractedAt), "dd/MM/yyyy HH:mm", { locale: es }),
      status: product.status ?? "",
      observations: product.observations ?? "",
    });

    // Zebra striping
    const bgColor = idx % 2 === 0 ? "FFFAFAFA" : "FFF0F4F8";
    row.eachCell((cell) => {
      cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: bgColor } };
      cell.alignment = { vertical: "middle", wrapText: false };
    });

    // Price columns as numbers with format
    const priceCell = row.getCell("wholesalePrice");
    const oldPriceCell = row.getCell("oldPrice");
    if (priceCell.value !== null && priceCell.value !== "") {
      priceCell.numFmt = '"$"#,##0.00';
      priceCell.font = { bold: true, color: { argb: "FF1A5276" } };
    }
    if (oldPriceCell.value !== null && oldPriceCell.value !== "") {
      oldPriceCell.numFmt = '"$"#,##0.00';
      oldPriceCell.font = { color: { argb: "FF808080" }, strike: true };
    }

    // URL as hyperlink
    if (product.productUrl) {
      const urlCell = row.getCell("productUrl");
      urlCell.value = { text: "Ver producto", hyperlink: product.productUrl };
      urlCell.font = { color: { argb: "FF0563C1" }, underline: true };
    }
    if (product.imageUrl) {
      const imgCell = row.getCell("imageUrl");
      imgCell.value = { text: "Ver imagen", hyperlink: product.imageUrl };
      imgCell.font = { color: { argb: "FF0563C1" }, underline: true };
    }
  });

  // Auto filters on all columns
  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: columns.length },
  };

  // ── Hoja Resumen ─────────────────────────────────────────────────
  const summary = workbook.addWorksheet("Resumen");
  const withPrice = products.filter((p) => p.wholesalePrice !== null).length;
  const withoutPrice = products.length - withPrice;
  const withoutSku = products.filter((p) => !p.sku).length;

  const summaryData = [
    ["RESUMEN DE EXTRACCIÓN", ""],
    ["", ""],
    ["Proveedor", provider.name],
    ["URL Base", provider.baseUrl],
    ["Fecha extracción", format(new Date(), "dd/MM/yyyy HH:mm", { locale: es })],
    ["", ""],
    ["ESTADÍSTICAS", ""],
    ["Total productos", products.length],
    ["Con precio", withPrice],
    ["Sin precio", withoutPrice],
    ["Sin SKU", withoutSku],
  ];

  summaryData.forEach((rowData, i) => {
    const row = summary.addRow(rowData);
    if (i === 0 || i === 6) {
      row.getCell(1).font = { bold: true, size: 13, color: { argb: "FF1E3A5F" } };
      row.getCell(1).fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFEBF5FB" } };
    }
    if (i > 6) {
      row.getCell(2).font = { bold: true };
    }
  });

  summary.getColumn(1).width = 25;
  summary.getColumn(2).width = 35;

  // ── Save file ────────────────────────────────────────────────────
  // Guardar en /exports (carpeta local en raíz del proyecto, no en public/)
  // Esto permite servir el archivo via /api/extractions/:id/download
  // sin exponerlo directamente como asset estático.
  const outputDir = path.join(process.cwd(), "exports");
  await fs.mkdir(outputDir, { recursive: true });

  const filename = `extraccion_${slugify(provider.name)}_${jobId}_${format(new Date(), "yyyyMMdd-HHmm")}.xlsx`;
  const filePath = path.join(outputDir, filename);
  await workbook.xlsx.writeFile(filePath);

  return {
    filePath,
    fileUrl: `/api/extractions/download/${filename}`,
  };
}

function slugify(text: string): string {
  return text.toLowerCase().replace(/\s+/g, "_").replace(/[^\w_]/g, "");
}
