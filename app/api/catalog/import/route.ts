// POST /api/catalog/import — recibe multipart/form-data con un archivo Excel/CSV
// + providerId. Hace upsert de CatalogProduct (sourceType=IMPORTED) por
// (userId, providerId, sku). Crea categorías que no existan. Asigna imagen
// principal si viene URL. Devuelve resumen.

import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { buildPublicationSku } from "@/lib/catalog/publication-sku";
import {
  pickField,
  parseImportNumber,
  parseImportMargin,
  INVALID_SKU_RE,
} from "@/lib/catalog/import-aliases";

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
  removed: number;
  errors: { row: number; sku?: string; message: string }[];
  importBatchId: string;
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
    removed: 0,
    errors: [],
    importBatchId,
  };

  const categoryCache = new Map<string, string>();

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const rowNum = i + 2; // +1 por header, +1 base-1
    try {
      // SKU PROVEEDOR es la identidad técnica (match contra CatalogProduct.sku).
      // SKU WEB es la identidad comercial (publicationSku). Si solo viene uno
      // de los dos, usamos ese para ambos.
      const skuProveedor = pickField(r, "sku");
      const skuWeb = pickField(r, "publicationSku");
      const sku = skuProveedor || skuWeb;

      if (!sku || INVALID_SKU_RE.test(sku)) {
        report.errors.push({
          row: rowNum,
          message: `SKU inválido o ausente${sku ? ` ("${sku}")` : ""}`,
        });
        report.skipped++;
        continue;
      }

      const name = pickField(r, "name");
      if (!name) {
        report.errors.push({ row: rowNum, sku, message: "Falta nombre" });
        report.skipped++;
        continue;
      }

      const commercialName = pickField(r, "commercialName");
      const costRaw = pickField(r, "cost");
      const marginRaw = pickField(r, "margin");
      const finalPriceRaw = pickField(r, "finalPrice");
      const stock = pickField(r, "stock");
      const categoryRaw = pickField(r, "category");
      const imageUrl = pickField(r, "imageUrl");

      const wholesalePrice = parseImportNumber(costRaw);
      const manualMargin = parseImportMargin(marginRaw);
      const finalPrice = parseImportNumber(finalPriceRaw);
      // Si el Excel trae SKU WEB explícito lo respetamos; si no, derivamos del
      // prefijo del proveedor.
      const publicationSku = skuWeb || buildPublicationSku(prefix, sku);

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
        select: {
          id: true,
          assignedCategoryId: true,
          _count: { select: { categories: true } },
        },
      });

      if (existing) {
        // REGLA: solo asignar la categoría del Excel si el producto NO tiene
        // ninguna categoría asignada por el usuario (ni vía M2M ni vía
        // assignedCategoryId). Si ya tiene una, respetamos la elección
        // comercial y no la pisamos.
        const hasUserCategories =
          existing._count.categories > 0 || existing.assignedCategoryId != null;
        const shouldAssignCategory =
          assignedCategoryId != null && !hasUserCategories;

        await prisma.catalogProduct.update({
          where: { id: existing.id },
          data: {
            sourceType: "IMPORTED",
            importBatchId,
            supplierStatus: "ACTIVE",
            commercialTitle: commercialName || undefined,
            wholesalePrice: wholesalePrice ?? undefined,
            stock: stock || undefined,
            ...(shouldAssignCategory
              ? { assignedCategoryId }
              : {}),
            manualMargin: manualMargin ?? undefined,
            finalPrice: finalPrice ?? undefined,
            publicationSku,
            lastSeenAt: new Date(),
          },
        });

        // Espejo en la M2M para mantener consistencia.
        if (shouldAssignCategory && assignedCategoryId) {
          await prisma.catalogProductCategory.upsert({
            where: {
              catalogProductId_categoryId: {
                catalogProductId: existing.id,
                categoryId: assignedCategoryId,
              },
            },
            create: {
              catalogProductId: existing.id,
              categoryId: assignedCategoryId,
              isPrimary: true,
            },
            update: { isPrimary: true },
          });
        }

        report.updated++;
      } else {
        const created = await prisma.catalogProduct.create({
          data: {
            userId: session.user.id,
            providerId,
            sku,
            publicationSku,
            supplierName: name,
            commercialTitle: commercialName || null,
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

        // Espejo en la M2M para productos recién creados.
        if (assignedCategoryId) {
          await prisma.catalogProductCategory.create({
            data: {
              catalogProductId: created.id,
              categoryId: assignedCategoryId,
              isPrimary: true,
            },
          });
        }

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

  // Reconciliación: marcar como SUPPLIER_REMOVED los productos del proveedor
  // que no aparecieron en este Excel. Mismo criterio de SKU que el loop
  // (skuProveedor || skuWeb) para no marcar como removidos los que vienen sólo
  // con SKU WEB. Excluimos MANUAL — esos no son parte del snapshot del proveedor
  // y no deberían pisarse por una importación.
  //
  // Auto-pause: si el producto está PREPARED y stockSource=SUPPLIER, también lo
  // pasamos a PAUSED para evitar publicar algo sin stock. OWN/HYBRID conservan
  // estado; IGNORED queda fuera.
  const importedSkus = rows
    .map((r) => pickField(r, "sku") || pickField(r, "publicationSku"))
    .filter((s) => s && !INVALID_SKU_RE.test(s));

  if (importedSkus.length > 0) {
    const baseWhere = {
      userId: session.user.id,
      providerId,
      supplierStatus: "ACTIVE" as const,
      sourceType: { in: ["SCRAPED", "IMPORTED"] as ("SCRAPED" | "IMPORTED")[] },
      sku: { notIn: importedSkus },
    };

    // Caso 1: PREPARED + stockSource SUPPLIER → PAUSED + SUPPLIER_REMOVED
    const removedPaused = await prisma.catalogProduct.updateMany({
      where: {
        ...baseWhere,
        stockSource: "SUPPLIER",
        internalStatus: "PREPARED",
      },
      data: {
        supplierStatus: "SUPPLIER_REMOVED",
        internalStatus: "PAUSED",
      },
    });

    // Caso 2: el resto (excepto IGNORED y el caso 1) → solo SUPPLIER_REMOVED
    const removedRest = await prisma.catalogProduct.updateMany({
      where: {
        ...baseWhere,
        internalStatus: { not: "IGNORED" },
        NOT: {
          AND: [
            { stockSource: "SUPPLIER" },
            { internalStatus: "PREPARED" },
          ],
        },
      },
      data: { supplierStatus: "SUPPLIER_REMOVED" },
    });

    report.removed = removedPaused.count + removedRest.count;
  }

  return NextResponse.json(report);
}
