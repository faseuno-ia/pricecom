// POST /api/catalog/import — recibe multipart/form-data con un archivo Excel/CSV
// + providerId. Hace upsert de CatalogProduct (sourceType=IMPORTED) por
// (userId, providerId, sku). Crea categorías que no existan. Asigna imagen
// principal si viene URL.
//
// Además del upsert, al cerrar el batch emite un ExtractionJob sintético
// con source="IMPORT" + ExtractionComparison + ProductChange[] para que el
// diff (nuevos / removidos / precios) aparezca en el dashboard del provider
// y en /changes, igual que para los proveedores SCRAPER. El worker ignora
// estos jobs (filtra source IS NULL).

import { NextRequest, NextResponse } from "next/server";
import * as XLSX from "xlsx";
import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { buildPublicationSku } from "@/lib/catalog/publication-sku";
import { findCollidingSkuInPricEcom } from "@/lib/catalog/sku-guards";
import {
  pickField,
  parseImportNumber,
  parseImportMargin,
  INVALID_SKU_RE,
} from "@/lib/catalog/import-aliases";
import { logInfo, logWarning } from "@/lib/events/event-log";

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
  diff: {
    new: number;
    removed: number;
    priceUp: number;
    priceDown: number;
  };
}

interface DiffChange {
  sku: string;
  name: string;
  previousPrice: number | null;
  currentPrice: number | null;
  previousStock: string | null;
  currentStock: string | null;
}

function priceChangePercent(prev: number, curr: number): number | null {
  if (prev === 0) return null;
  return Math.round(((curr - prev) / prev) * 10000) / 100; // 2 decimales
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
    diff: { new: 0, removed: 0, priceUp: 0, priceDown: 0 },
  };

  // Pre-fetch de TODOS los CatalogProduct del provider — 1 query reemplaza
  // los N findFirst que hacíamos en el loop. Indexamos por SKU para lookup
  // O(1) y obtenemos el snapshot previo necesario para diff de precios.
  const existingProducts = await prisma.catalogProduct.findMany({
    where: { providerId, userId: session.user.id },
    select: {
      id: true,
      sku: true,
      supplierName: true,
      wholesalePrice: true,
      stock: true,
      assignedCategoryId: true,
      supplierStatus: true,
      _count: { select: { categories: true } },
    },
  });
  const existingBySku = new Map<string, (typeof existingProducts)[number]>();
  for (const p of existingProducts) {
    if (p.sku) existingBySku.set(p.sku, p);
  }

  const categoryCache = new Map<string, string>();

  // Fase 4F guard: tracking de publicationSku dentro del mismo Excel. Si dos
  // filas traen el mismo SKU comercial (con sku raw distinto, o ambos sin sku
  // raw), la segunda es colisión intra-batch — se reporta y se saltea.
  // Map clave = publicationSku, valor = rowNum donde apareció primero.
  const seenPubSkuInExcel = new Map<string, number>();

  // Acumuladores de diff para emitir ProductChange al final.
  const diffNew: DiffChange[] = [];
  const diffPriceUp: DiffChange[] = [];
  const diffPriceDown: DiffChange[] = [];

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

      const existing = existingBySku.get(sku);

      // Fase 4F guard: colisión del publicationSku (1) entre filas del mismo
      // Excel, (2) contra el resto del catálogo en DB. Cuando es UPDATE de
      // un cp existente (matchea por sku raw), excluimos su propio cp.id
      // para que no se cuente como conflicto consigo mismo.
      if (publicationSku) {
        const firstSeenRow = seenPubSkuInExcel.get(publicationSku);
        if (firstSeenRow !== undefined && firstSeenRow !== rowNum) {
          report.errors.push({
            row: rowNum,
            sku,
            message: `SKU comercial "${publicationSku}" duplicado en el Excel (también aparece en la fila ${firstSeenRow}).`,
          });
          report.skipped++;
          continue;
        }
        seenPubSkuInExcel.set(publicationSku, rowNum);

        const collision = await findCollidingSkuInPricEcom(
          prisma,
          session.user.id,
          publicationSku,
          existing ? { catalogProductId: existing.id } : undefined
        );
        if (collision) {
          report.errors.push({
            row: rowNum,
            sku,
            message: `SKU comercial "${publicationSku}" ya pertenece a otro producto del catálogo (${collision.supplierName.slice(0, 60)}).`,
          });
          report.skipped++;
          continue;
        }
      }

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

        // Diff de precio — solo si ambos lados tienen valor.
        if (
          wholesalePrice != null &&
          existing.wholesalePrice != null &&
          wholesalePrice !== existing.wholesalePrice
        ) {
          const record: DiffChange = {
            sku,
            name: existing.supplierName ?? name,
            previousPrice: existing.wholesalePrice,
            currentPrice: wholesalePrice,
            previousStock: existing.stock,
            currentStock: stock || null,
          };
          if (wholesalePrice > existing.wholesalePrice) diffPriceUp.push(record);
          else diffPriceDown.push(record);
        }
      } else {
        await prisma.catalogProduct.create({
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
          select: { id: true },
        });
        report.created++;
        diffNew.push({
          sku,
          name,
          previousPrice: null,
          currentPrice: wholesalePrice,
          previousStock: null,
          currentStock: stock || null,
        });

        // Espejo en la M2M para productos recién creados.
        if (assignedCategoryId) {
          // El producto recién creado no estaba en el map; resolvemos su id
          // por (userId, providerId, sku) que es unique.
          const fresh = await prisma.catalogProduct.findUnique({
            where: {
              userId_providerId_sku: {
                userId: session.user.id,
                providerId,
                sku,
              },
            },
            select: { id: true },
          });
          if (fresh) {
            await prisma.catalogProductCategory.create({
              data: {
                catalogProductId: fresh.id,
                categoryId: assignedCategoryId,
                isPrimary: true,
              },
            });
            if (imageUrl) {
              await prisma.catalogProductImage.create({
                data: {
                  catalogProductId: fresh.id,
                  url: imageUrl,
                  position: 0,
                  isPrimary: true,
                  source: "USER",
                },
              });
              report.imagesAdded++;
            }
          }
        } else if (imageUrl) {
          const fresh = await prisma.catalogProduct.findUnique({
            where: {
              userId_providerId_sku: {
                userId: session.user.id,
                providerId,
                sku,
              },
            },
            select: { id: true },
          });
          if (fresh) {
            await prisma.catalogProductImage.create({
              data: {
                catalogProductId: fresh.id,
                url: imageUrl,
                position: 0,
                isPrimary: true,
                source: "USER",
              },
            });
            report.imagesAdded++;
          }
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

  // Capturamos los productos que pasarán a SUPPLIER_REMOVED en este import
  // (antes de aplicar el cambio) para emitir ProductChange tipo REMOVED.
  const diffRemoved: DiffChange[] = [];
  if (importedSkus.length > 0) {
    const removed = await prisma.catalogProduct.findMany({
      where: {
        userId: session.user.id,
        providerId,
        supplierStatus: "ACTIVE",
        sourceType: { in: ["SCRAPED", "IMPORTED"] },
        sku: { notIn: importedSkus },
        internalStatus: { not: "IGNORED" },
      },
      select: {
        sku: true,
        supplierName: true,
        wholesalePrice: true,
        stock: true,
      },
    });
    for (const p of removed) {
      if (!p.sku) continue;
      diffRemoved.push({
        sku: p.sku,
        name: p.supplierName,
        previousPrice: p.wholesalePrice,
        currentPrice: null,
        previousStock: p.stock,
        currentStock: null,
      });
    }
  }

  if (importedSkus.length > 0) {
    const baseWhere = {
      userId: session.user.id,
      providerId,
      supplierStatus: "ACTIVE" as const,
      sourceType: { in: ["SCRAPED", "IMPORTED"] as ("SCRAPED" | "IMPORTED")[] },
      sku: { notIn: importedSkus },
    };

    // Caso 1: PREPARED|PUBLISHED + stockSource SUPPLIER → PAUSED + SUPPLIER_REMOVED.
    // Pre-resolvemos los IDs para poder propagar pendingSync=true a sus
    // ProductPublication (que están desincronizadas: PricEcom = PAUSED pero
    // WooCommerce sigue mostrando publish).
    const toAutoPause = await prisma.catalogProduct.findMany({
      where: {
        ...baseWhere,
        stockSource: "SUPPLIER",
        internalStatus: { in: ["PREPARED", "PUBLISHED"] },
      },
      select: { id: true },
    });

    let removedPausedCount = 0;
    if (toAutoPause.length > 0) {
      const pauseIds = toAutoPause.map((p) => p.id);
      const removedPaused = await prisma.catalogProduct.updateMany({
        where: { id: { in: pauseIds } },
        data: {
          supplierStatus: "SUPPLIER_REMOVED",
          internalStatus: "PAUSED",
        },
      });
      removedPausedCount = removedPaused.count;
      await prisma.productPublication.updateMany({
        where: {
          catalogProductId: { in: pauseIds },
          status: "ACTIVE",
        },
        data: { pendingSync: true, syncStatus: "PENDING_SYNC" },
      });
    }

    // Caso 2: el resto (excepto IGNORED y el caso 1) → solo SUPPLIER_REMOVED
    const removedRest = await prisma.catalogProduct.updateMany({
      where: {
        ...baseWhere,
        internalStatus: { not: "IGNORED" },
        NOT: {
          AND: [
            { stockSource: "SUPPLIER" },
            { internalStatus: { in: ["PREPARED", "PUBLISHED"] } },
          ],
        },
      },
      data: { supplierStatus: "SUPPLIER_REMOVED" },
    });

    report.removed = removedPausedCount + removedRest.count;
  }

  // Emisión del job sintético + comparison + changes. Se hace en una sola
  // transacción para mantener consistencia: si algo falla, no quedan jobs
  // huérfanos en COMPLETED sin su diff.
  report.diff = {
    new: diffNew.length,
    removed: diffRemoved.length,
    priceUp: diffPriceUp.length,
    priceDown: diffPriceDown.length,
  };

  const hasAnyChange =
    diffNew.length + diffRemoved.length + diffPriceUp.length + diffPriceDown.length >
    0;

  if (hasAnyChange) {
    await prisma.$transaction(async (tx) => {
      const job = await tx.extractionJob.create({
        data: {
          providerId,
          userId: session.user.id,
          status: "COMPLETED",
          source: "IMPORT",
          importBatchId,
          finishedAt: new Date(),
          startedAt: new Date(),
          progress: 100,
          totalProducts: importedSkus.length,
        },
        select: { id: true },
      });

      const comparison = await tx.extractionComparison.create({
        data: {
          jobId: job.id,
          previousJobId: null,
          newProducts: diffNew.length,
          removedProducts: diffRemoved.length,
          priceUp: diffPriceUp.length,
          priceDown: diffPriceDown.length,
          stockChanged: 0,
          unchanged: 0,
        },
        select: { id: true },
      });

      const changes = [
        ...diffNew.map((d) => ({
          comparisonId: comparison.id,
          sku: d.sku,
          name: d.name,
          changeType: "NEW" as const,
          previousPrice: d.previousPrice,
          currentPrice: d.currentPrice,
          previousStock: d.previousStock,
          currentStock: d.currentStock,
          importBatchId,
        })),
        ...diffRemoved.map((d) => ({
          comparisonId: comparison.id,
          sku: d.sku,
          name: d.name,
          changeType: "REMOVED" as const,
          previousPrice: d.previousPrice,
          currentPrice: d.currentPrice,
          previousStock: d.previousStock,
          currentStock: d.currentStock,
          importBatchId,
        })),
        ...diffPriceUp.map((d) => ({
          comparisonId: comparison.id,
          sku: d.sku,
          name: d.name,
          changeType: "PRICE_UP" as const,
          previousPrice: d.previousPrice,
          currentPrice: d.currentPrice,
          priceChangePercent:
            d.previousPrice != null && d.currentPrice != null
              ? priceChangePercent(d.previousPrice, d.currentPrice)
              : null,
          previousStock: d.previousStock,
          currentStock: d.currentStock,
          importBatchId,
        })),
        ...diffPriceDown.map((d) => ({
          comparisonId: comparison.id,
          sku: d.sku,
          name: d.name,
          changeType: "PRICE_DOWN" as const,
          previousPrice: d.previousPrice,
          currentPrice: d.currentPrice,
          priceChangePercent:
            d.previousPrice != null && d.currentPrice != null
              ? priceChangePercent(d.previousPrice, d.currentPrice)
              : null,
          previousStock: d.previousStock,
          currentStock: d.currentStock,
          importBatchId,
        })),
      ];

      if (changes.length > 0) {
        await tx.productChange.createMany({ data: changes });
      }
    });
  }

  const importLog =
    report.errors.length > 0 ? logWarning : logInfo;
  await importLog({
    source: "IMPORT",
    type: report.errors.length > 0 ? "IMPORT_PARTIAL" : "IMPORT_COMPLETED",
    title:
      report.errors.length > 0
        ? `Importación completada con ${report.errors.length} error(es) — ${provider.name}`
        : `Importación completada — ${provider.name}`,
    userId: session.user.id,
    providerId,
    metadata: {
      created: report.created,
      updated: report.updated,
      removed: report.removed,
      errors: report.errors.length,
      diff: report.diff,
      importBatchId: report.importBatchId,
    },
  });

  return NextResponse.json(report);
}
