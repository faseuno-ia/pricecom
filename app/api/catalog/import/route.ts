// POST /api/catalog/import — recibe multipart/form-data con un archivo Excel/CSV
// + providerId. Hace upsert de CatalogProduct (sourceType=IMPORTED) por
// (userId, providerId, sku). Crea categorías que no existan. Asigna imagen
// principal si viene URL. Devuelve resumen.

import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { buildPublicationSku } from "@/lib/catalog/publication-sku";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_ROWS = 5000;

interface ImportReport {
  total: number;
  created: number;
  updated: number;
  skipped: number;
  categoriesCreated: number;
  imagesAdded: number;
  errors: { row: number; sku?: string; message: string }[];
  importBatchId: string;
}

// Aliases tolerantes para los nombres de columna del Excel.
function pick(row: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = row[k];
    if (v != null && String(v).trim() !== "") return String(v).trim();
  }
  return "";
}

function parseNumber(s: string): number | null {
  if (!s) return null;
  const cleaned = s.replace(/[$\s]/g, "").replace(",", ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseMargin(s: string): number | null {
  if (!s) return null;
  const cleaned = s.replace("%", "").replace(",", ".").trim();
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return n <= 1 && n > 0 ? n * 100 : n;
}

export async function POST(req: NextRequest) {
  const session = await requireSession();

  const formData = await req.formData().catch(() => null);
  if (!formData) {
    return NextResponse.json({ error: "Body inválido (no multipart)" }, { status: 400 });
  }
  const file = formData.get("file");
  const providerId = formData.get("providerId");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Archivo requerido" }, { status: 400 });
  }
  if (typeof providerId !== "string" || !providerId) {
    return NextResponse.json({ error: "providerId requerido" }, { status: 400 });
  }

  const provider = await prisma.provider.findFirst({
    where: { id: providerId, userId: session.user.id },
    include: { scraperConfig: { select: { imageFilenamePrefix: true } } },
  });
  if (!provider) {
    return NextResponse.json(
      { error: "Proveedor no encontrado o sin permiso" },
      { status: 404 }
    );
  }
  const prefix = provider.scraperConfig?.imageFilenamePrefix ?? null;

  let rows: Record<string, unknown>[];
  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const wb = XLSX.read(buffer, { type: "buffer" });
    const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: "" });
  } catch {
    return NextResponse.json(
      { error: "No se pudo leer el archivo (¿Excel o CSV válido?)" },
      { status: 400 }
    );
  }

  if (rows.length === 0) {
    return NextResponse.json({ error: "El archivo está vacío" }, { status: 400 });
  }
  if (rows.length > MAX_ROWS) {
    return NextResponse.json(
      { error: `Máximo ${MAX_ROWS} filas por importación (encontradas ${rows.length}).` },
      { status: 400 }
    );
  }

  const importBatchId = `imp_${Date.now()}_${Math.random()
    .toString(36)
    .slice(2, 8)}`;

  const report: ImportReport = {
    total: rows.length,
    created: 0,
    updated: 0,
    skipped: 0,
    categoriesCreated: 0,
    imagesAdded: 0,
    errors: [],
    importBatchId,
  };

  const categoryCache = new Map<string, string>();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNum = i + 2; // +1 por header, +1 base-1
    try {
      const sku = pick(r, "SKU", "Sku", "sku", "Código", "Codigo");
      if (!sku || sku.toUpperCase() === "#N/A") {
        report.skipped++;
        continue;
      }
      const name = pick(r, "Nombre", "NOMBRE", "name", "Descripción", "DESCRIPCION");
      if (!name) {
        report.errors.push({ row: rowNum, sku, message: "Falta nombre" });
        report.skipped++;
        continue;
      }
      const description = pick(r, "Descripción", "DESCRIPCION", "description");
      const costRaw = pick(r, "Costo", "COSTO", "wholesalePrice", "Precio Mayorista");
      const marginRaw = pick(r, "Margen", "MARGEN", "marginPercent", "MARGEN WEB %");
      const finalPriceRaw = pick(r, "Precio Final", "FinalPrice", "Precio");
      const stock = pick(r, "Stock", "STOCK", "stock");
      const categoryRaw = pick(r, "Categoría", "Categoria", "CATEGORIA", "category");
      const imageUrl = pick(r, "Imagen URL", "Imagen", "IMAGEN", "image", "LINK FOTO");

      const wholesalePrice = parseNumber(costRaw);
      const manualMargin = parseMargin(marginRaw);
      const finalPrice = parseNumber(finalPriceRaw);
      const publicationSku = buildPublicationSku(prefix, sku);

      let assignedCategoryId: string | null = null;
      if (categoryRaw) {
        const key = categoryRaw.toUpperCase();
        const cached = categoryCache.get(key);
        if (cached) {
          assignedCategoryId = cached;
        } else {
          const existing = await prisma.category.findFirst({
            where: { name: { equals: categoryRaw, mode: "insensitive" } },
            select: { id: true },
          });
          if (existing) {
            assignedCategoryId = existing.id;
          } else {
            const created = await prisma.category.create({
              data: { name: categoryRaw },
              select: { id: true },
            });
            assignedCategoryId = created.id;
            report.categoriesCreated++;
          }
          categoryCache.set(key, assignedCategoryId);
        }
      }

      // Upsert por (userId, providerId, sku) — pero la unicidad de prisma usa
      // userId_providerId_sku como clave compuesta única.
      const existing = await prisma.catalogProduct.findFirst({
        where: { userId: session.user.id, providerId, sku },
        select: { id: true },
      });

      if (existing) {
        await prisma.catalogProduct.update({
          where: { id: existing.id },
          data: {
            // Solo refrescamos campos del lado comercial e indicadores de origen;
            // el supplierName lo dejamos quieto si ya estaba (el archivo puede ser
            // menos confiable que el scrape).
            sourceType: "IMPORTED",
            importBatchId,
            supplierDescription: description || undefined,
            wholesalePrice: wholesalePrice ?? undefined,
            stock: stock || undefined,
            assignedCategoryId: assignedCategoryId ?? undefined,
            manualMargin: manualMargin ?? undefined,
            finalPrice: finalPrice ?? undefined,
            publicationSku,
            lastSeenAt: new Date(),
          },
        });
        report.updated++;
      } else {
        const created = await prisma.catalogProduct.create({
          data: {
            userId: session.user.id,
            providerId,
            sku,
            publicationSku,
            supplierName: name,
            supplierDescription: description || null,
            wholesalePrice,
            stock: stock || null,
            imageUrl: imageUrl || null,
            assignedCategoryId,
            manualMargin,
            finalPrice,
            sourceType: "IMPORTED",
            importBatchId,
            supplierStatus: "ACTIVE",
            internalStatus: "NOT_PUBLISHED",
            lastSeenAt: new Date(),
          },
        });
        report.created++;

        if (imageUrl) {
          await prisma.catalogProductImage.create({
            data: {
              catalogProductId: created.id,
              url: imageUrl,
              position: 0,
              isPrimary: true,
              source: "USER",
            },
          });
          report.imagesAdded++;
        }
      }
    } catch (err) {
      report.errors.push({
        row: rowNum,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return NextResponse.json(report);
}
