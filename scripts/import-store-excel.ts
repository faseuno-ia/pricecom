// Importador del Excel de la tienda existente del cliente (CLI).
//
// Match por SKU PROVEEDOR del Excel contra CatalogProduct.sku original; SKU WEB
// se guarda como publicationSku; NOMBRE WEB se guarda como commercialTitle.
// Para Excels viejos que no separan PROVEEDOR/WEB, hace fallback a la columna
// SKU única y deriva publicationSku con el prefix del proveedor.
//
// Nunca toca el sku original del proveedor.
//
// Uso:
//   npm run import:store-excel
//   npm run import:store-excel -- "ruta/al/archivo.xlsx"

import * as XLSX from "xlsx";
import { PrismaClient } from "@prisma/client";
import path from "path";
import fs from "fs";
import { buildPublicationSku } from "../lib/catalog/publication-sku";
import {
  pickField,
  parseImportMargin,
  parseImportNumber,
  INVALID_SKU_RE,
} from "../lib/catalog/import-aliases";
import { resolveImportSalePrice } from "../lib/catalog/import-price";

const prisma = new PrismaClient();

// Dry-run por DEFAULT: sin --apply no se escribe nada (ni backfill, ni update,
// ni categorías, ni imágenes). --apply es obligatorio para tocar la DB.
const APPLY = process.argv.includes("--apply");
// Ruta del Excel: argumento explícito obligatorio (SIN fallback a archivo
// default — correr sin ruta pisaba datos con un Excel viejo).
const FILE_ARG = process.argv.slice(2).find((a) => !a.startsWith("--"));

// Mapeo: nombre de proveedor en la columna PROVEEDOR del Excel → nombre del
// proveedor scrapeado en la DB. Solo lo usamos para scopear el match por
// providerId (evita falsos positivos entre proveedores con SKU parecidos).
const EXCEL_TO_DB_PROVIDER: Record<string, string> = {
  BAZAR380: "BAZAR 380",
  "BAZAR 380": "BAZAR 380",
  IMPOTEKNO: "IMPOTEKNO",
  TOYPALACE: "TOYS PALACE",
  TOYSPALACE: "TOYS PALACE",
  "TOYS PALACE": "TOYS PALACE",
  LACHIPELU: "LACHIPELU - VANESA",
  "LACHIPELU - VANESA": "LACHIPELU - VANESA",
};

async function backfillPublicationSku(): Promise<void> {
  console.log("Backfill de publicationSku (idempotente)...");
  const configs = await prisma.providerScraperConfig.findMany({
    select: { providerId: true, imageFilenamePrefix: true },
  });
  const prefixByProvider = new Map<string, string | null>();
  for (const c of configs) prefixByProvider.set(c.providerId, c.imageFilenamePrefix ?? null);

  const providers = await prisma.provider.findMany({ select: { id: true, name: true } });
  let updated = 0;
  for (const provider of providers) {
    const prefix = prefixByProvider.get(provider.id) ?? null;
    const products = await prisma.catalogProduct.findMany({
      where: { providerId: provider.id },
      select: { id: true, sku: true, publicationSku: true },
    });
    for (const p of products) {
      const computed = buildPublicationSku(prefix, p.sku);
      if (computed !== p.publicationSku) {
        if (APPLY) {
          await prisma.catalogProduct.update({
            where: { id: p.id },
            data: { publicationSku: computed },
          });
        }
        updated++;
      }
    }
  }
  console.log(`  ↳ publicationSku actualizados: ${updated}\n`);
}

async function main() {
  console.log(`[import] modo: ${APPLY ? "--apply (ESCRIBE)" : "--dry (read-only, default)"}`);

  if (!FILE_ARG) {
    console.error(
      "✗ Falta la ruta del Excel. Uso: npm run import:store-excel -- <archivo.xlsx> [--apply]"
    );
    process.exit(1);
  }
  const filePath = FILE_ARG;

  if (!fs.existsSync(filePath)) {
    console.error(`✗ Archivo no encontrado: ${filePath}`);
    process.exit(1);
  }

  console.log(`Leyendo Excel: ${filePath}`);
  const wb = XLSX.readFile(filePath);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws, {
    defval: "",
  });
  console.log(`Filas encontradas: ${rows.length}\n`);

  // Resolver usuario (favorece al que tiene catalogProducts).
  let user: { id: string; email: string } | null = null;
  const forcedEmail = process.env.USER_EMAIL;
  if (forcedEmail) {
    user = await prisma.user.findFirst({
      where: { email: forcedEmail },
      select: { id: true, email: true },
    });
    if (!user) throw new Error(`Usuario "${forcedEmail}" no encontrado`);
  } else {
    const candidates = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        _count: { select: { catalogProducts: true } },
      },
    });
    if (candidates.length === 0) throw new Error("No hay usuarios en la DB");
    candidates.sort(
      (a, b) => b._count.catalogProducts - a._count.catalogProducts
    );
    const top = candidates[0];
    user = { id: top.id, email: top.email };
    if (candidates.length > 1) {
      console.log(
        `Usuarios disponibles: ${candidates
          .map((c) => `${c.email} (${c._count.catalogProducts})`)
          .join(", ")}`
      );
    }
  }
  console.log(`Usuario seleccionado: ${user.email}\n`);

  await backfillPublicationSku();

  // Resolver providerId por nombre + prefix.
  const providerIdByName = new Map<string, string>();
  const prefixByProviderId = new Map<string, string | null>();
  const listDiscountByProviderId = new Map<string, number>();
  const dbProviders = await prisma.provider.findMany({
    where: { userId: user.id },
    select: {
      id: true,
      name: true,
      listDiscountPercent: true,
      scraperConfig: { select: { imageFilenamePrefix: true } },
    },
  });
  for (const p of dbProviders) {
    providerIdByName.set(p.name.trim().toUpperCase(), p.id);
    prefixByProviderId.set(p.id, p.scraperConfig?.imageFilenamePrefix ?? null);
    listDiscountByProviderId.set(p.id, Number(p.listDiscountPercent));
  }

  // Backup pre-imagen ANTES de cualquier write (patrón de cleanup-stale-finalprices).
  // Snapshot completo de los campos de precio del usuario → reversible por id.
  if (APPLY) {
    const snap = await prisma.catalogProduct.findMany({
      where: { userId: user.id },
      select: {
        id: true, sku: true, providerId: true, finalPrice: true,
        manualMargin: true, wholesalePrice: true, manualSourceNote: true, sourceType: true,
      },
    });
    const dir = path.join(process.cwd(), "artifacts", "backups");
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const backupPath = path.join(dir, `import-store-excel-pre-${ts}.json`);
    fs.writeFileSync(backupPath, JSON.stringify({ count: snap.length, rows: snap }, null, 2));
    console.log(`[import] backup pre-imagen: ${backupPath} (${snap.length} filas)\n`);
  }

  const report = {
    total: rows.length,
    skippedEmpty: 0,
    matched: 0,
    notFound: 0,
    updated: 0,
    titlesApplied: 0,
    marginsApplied: 0,
    freezesCleared: 0,
    categoriesAssigned: 0,
    categoriesCreated: 0,
    // Solo dry-run: lo que se HARÍA con --apply (no se escribe nada).
    categoriesWouldBeCreated: 0,
    categoriesWouldBeAssigned: 0,
    imagesAdded: 0,
    errors: [] as string[],
    notFoundSkus: [] as string[],
    byProvider: new Map<
      string,
      { total: number; matched: number; notFound: number }
    >(),
  };

  function bump(prov: string, key: "total" | "matched" | "notFound") {
    const cur = report.byProvider.get(prov) ?? {
      total: 0,
      matched: 0,
      notFound: 0,
    };
    cur[key]++;
    report.byProvider.set(prov, cur);
  }

  const categoryCache = new Map<string, string>();

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const rowNum = i + 2;
    try {
      const providerName = String(row["PROVEEDOR"] ?? "").trim();
      const skuProveedor = pickField(row, "sku");
      const skuWeb = pickField(row, "publicationSku");
      const name = pickField(row, "name");
      const commercialName = pickField(row, "commercialName");
      const marginRaw = pickField(row, "margin");
      const salePriceRaw = pickField(row, "salePrice");
      const categoryRaw = pickField(row, "category");
      const imageUrl = pickField(row, "imageUrl");

      // Identidad técnica para el match: SKU PROVEEDOR si vino; si no, SKU WEB.
      const matchSku = skuProveedor || skuWeb;
      if (!matchSku || INVALID_SKU_RE.test(matchSku)) {
        report.skippedEmpty++;
        continue;
      }

      const provLabel = providerName || "(sin proveedor)";
      bump(provLabel, "total");

      // Scope por providerId si conocemos el mapeo del Excel → DB.
      const dbProviderName = EXCEL_TO_DB_PROVIDER[providerName.toUpperCase()];
      const providerIdScope = dbProviderName
        ? providerIdByName.get(dbProviderName.toUpperCase())
        : undefined;

      // Match: 1) por sku original (preferido), 2) por publicationSku como fallback.
      let catalogProduct = await prisma.catalogProduct.findFirst({
        where: {
          userId: user.id,
          sku: matchSku,
          ...(providerIdScope ? { providerId: providerIdScope } : {}),
        },
        include: { images: { where: { isPrimary: true }, take: 1 } },
      });

      if (!catalogProduct && skuWeb) {
        catalogProduct = await prisma.catalogProduct.findFirst({
          where: {
            userId: user.id,
            publicationSku: skuWeb,
            ...(providerIdScope ? { providerId: providerIdScope } : {}),
          },
          include: { images: { where: { isPrimary: true }, take: 1 } },
        });
      }

      if (!catalogProduct) {
        report.notFound++;
        report.notFoundSkus.push(
          `[${provLabel}] ${matchSku}${commercialName ? " — " + commercialName : name ? " — " + name : ""}`
        );
        bump(provLabel, "notFound");
        continue;
      }

      report.matched++;
      bump(provLabel, "matched");

      const explicitMargin = parseImportMargin(marginRaw);
      const webPrice = parseImportNumber(salePriceRaw);

      // Precio de venta del Excel → margen recalculable (default seguro). NO
      // congela finalPrice; solo limpia un freeze involuntario previo. Margen
      // explícito (MARGEN WEB) tiene precedencia sobre el derivado.
      const listDiscount =
        listDiscountByProviderId.get(catalogProduct.providerId) ?? 0;
      const resolved = resolveImportSalePrice({
        webPrice,
        wholesalePrice: catalogProduct.wholesalePrice ?? null,
        listDiscountPercent: listDiscount,
        existing: {
          finalPrice: catalogProduct.finalPrice,
          wholesalePrice: catalogProduct.wholesalePrice,
          manualMargin: catalogProduct.manualMargin,
          manualSourceNote: catalogProduct.manualSourceNote,
          sourceType: catalogProduct.sourceType,
        },
      });
      const marginToWrite = explicitMargin ?? resolved.manualMargin;

      // Computar publicationSku: el del Excel si vino; si no, derivar con prefix.
      const providerPrefix =
        prefixByProviderId.get(catalogProduct.providerId) ?? null;
      const publicationSku =
        skuWeb || buildPublicationSku(providerPrefix, catalogProduct.sku);

      const updateData: Record<string, unknown> = {};
      if (commercialName) {
        updateData.commercialTitle = commercialName;
        report.titlesApplied++;
      }
      if (marginToWrite != null) {
        updateData.manualMargin = marginToWrite;
        report.marginsApplied++;
      }
      if (resolved.clearFinalPrice) {
        updateData.finalPrice = null;
        report.freezesCleared++;
      }
      if (publicationSku && publicationSku !== catalogProduct.publicationSku) {
        updateData.publicationSku = publicationSku;
      }

      if (categoryRaw) {
        const primary = categoryRaw.split(",")[0].trim();
        if (primary) {
          const key = primary.toUpperCase();
          // Solo cacheamos IDs REALES. En dry-run, una categoría inexistente no
          // se crea ni se cachea (no hay pseudo-ID): se cuenta como "would-be".
          let categoryId: string | undefined = categoryCache.get(key);
          if (!categoryId) {
            const existing = await prisma.category.findFirst({
              where: { name: { equals: primary, mode: "insensitive" } },
              select: { id: true },
            });
            if (existing) {
              categoryId = existing.id;
            } else if (APPLY) {
              const created = await prisma.category.create({
                data: { name: primary },
                select: { id: true },
              });
              categoryId = created.id;
              report.categoriesCreated++;
              console.log(`  ✚ Categoría creada: ${primary}`);
            } else {
              // dry-run: la categoría se crearía con --apply; no hay ID real.
              report.categoriesWouldBeCreated++;
            }
            if (categoryId) categoryCache.set(key, categoryId);
          }
          // Solo asignamos si tenemos un ID real. En dry-run sin ID, se contabiliza
          // como asignación planeada (no se escribe nada).
          if (categoryId) {
            updateData.assignedCategoryId = categoryId;
            report.categoriesAssigned++;
          } else {
            report.categoriesWouldBeAssigned++;
          }
        }
      }

      if (Object.keys(updateData).length > 0) {
        if (APPLY) {
          await prisma.catalogProduct.update({
            where: { id: catalogProduct.id },
            data: updateData,
          });
        }
        report.updated++;
      }

      // Imagen primaria si el producto no tiene una y el Excel trae URL válida.
      if (
        imageUrl &&
        imageUrl.startsWith("http") &&
        !catalogProduct.images[0]
      ) {
        if (APPLY) {
          await prisma.catalogProductImage.create({
            data: {
              catalogProductId: catalogProduct.id,
              url: imageUrl,
              position: 0,
              isPrimary: true,
              source: "USER",
              altText: commercialName || name || null,
            },
          });
        }
        report.imagesAdded++;
      }
    } catch (err) {
      report.errors.push(
        `Fila ${rowNum}: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    if ((i + 1) % 100 === 0) {
      console.log(
        `  · procesadas ${i + 1}/${rows.length} (matched: ${report.matched}, notFound: ${report.notFound})`
      );
    }
  }

  console.log("\n═══════════════════════════════════════");
  console.log("REPORTE DE IMPORTACIÓN");
  console.log("═══════════════════════════════════════");
  console.log(`Total filas Excel:      ${report.total}`);
  console.log(`Saltadas (SKU vacío):   ${report.skippedEmpty}`);
  console.log(`Matcheados:             ${report.matched}`);
  console.log(`No encontrados:         ${report.notFound}`);
  console.log(`Actualizados:           ${report.updated}`);
  console.log(`Títulos aplicados:      ${report.titlesApplied}`);
  console.log(`Márgenes aplicados:     ${report.marginsApplied}`);
  console.log(`Freezes limpiados:      ${report.freezesCleared}`);
  console.log(`Categorías asignadas:   ${report.categoriesAssigned}`);
  console.log(`Categorías creadas:     ${report.categoriesCreated}`);
  if (!APPLY) {
    console.log(`Categorías a crear (would-be):    ${report.categoriesWouldBeCreated}`);
    console.log(`Categorías a asignar (would-be):  ${report.categoriesWouldBeAssigned}`);
  }
  console.log(`Imágenes agregadas:     ${report.imagesAdded}`);
  console.log(`Errores:                ${report.errors.length}`);

  console.log("\nPor PROVEEDOR (Excel):");
  const sortedByProv = [...report.byProvider.entries()].sort(
    (a, b) => b[1].total - a[1].total
  );
  for (const [prov, stats] of sortedByProv) {
    const pct =
      stats.total > 0 ? Math.round((stats.matched / stats.total) * 100) : 0;
    console.log(
      `  ${prov.padEnd(15)} total=${stats.total.toString().padStart(4)}  matched=${stats.matched.toString().padStart(4)} (${pct}%)  notFound=${stats.notFound}`
    );
  }

  if (report.notFoundSkus.length > 0) {
    console.log(
      `\nSKUs no encontrados (mostrando primeros 20 de ${report.notFoundSkus.length}):`
    );
    report.notFoundSkus.slice(0, 20).forEach((s) => console.log(`  - ${s}`));
  }

  if (report.errors.length > 0) {
    console.log("\nErrores:");
    report.errors.forEach((e) => console.log(`  ✗ ${e}`));
  }

  console.log("\n✓ Importación completada");
}

main()
  .catch((err) => {
    console.error("Error fatal:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
