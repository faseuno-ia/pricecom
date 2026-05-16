// Importador del Excel de la tienda existente del cliente.
//
// Match por publicationSku (campo derivado del prefix del proveedor + sku original).
// El Excel ya contiene el publicationSku directamente en la columna SKU
// (ej: "B380-94028", "TP-85581"); por eso no hay que pelar prefijos: la columna
// SKU del Excel se compara tal cual contra CatalogProduct.publicationSku.
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

const prisma = new PrismaClient();

// Mapeo: nombre de proveedor en la columna PROVEEDOR del Excel → nombre del
// proveedor scrapeado en la DB. Solo lo usamos para scopear el match por
// providerId (evita falsos positivos entre proveedores con publicationSku
// parecidos). Si el Excel viene con un proveedor no mapeado, no scopeamos.
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

function parseMargin(raw: unknown): number | null {
  if (raw == null || raw === "" || raw === "#N/A") return null;
  if (typeof raw === "number") {
    return raw <= 1 && raw > 0 ? raw * 100 : raw;
  }
  const cleaned = String(raw).replace("%", "").replace(",", ".").trim();
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return n <= 1 && n > 0 ? n * 100 : n;
}

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
        await prisma.catalogProduct.update({
          where: { id: p.id },
          data: { publicationSku: computed },
        });
        updated++;
      }
    }
  }
  console.log(`  ↳ publicationSku actualizados: ${updated}\n`);
}

async function main() {
  const filePath =
    process.argv[2] ??
    path.join(
      process.cwd(),
      "scripts",
      "listado_completo_productos_web_con_margen.xlsx"
    );

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

  // Si hay más de un usuario, elegimos el que tenga catalogProducts. Si pasaron
  // USER_EMAIL en env, lo respetamos. Esto evita correr el import contra un
  // usuario legacy vacío.
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

  // Asegura que todos los CatalogProduct tengan publicationSku antes de matchear.
  await backfillPublicationSku();

  // Resolver providerId por nombre (DB).
  const providerIdByName = new Map<string, string>();
  const dbProviders = await prisma.provider.findMany({
    where: { userId: user.id },
    select: { id: true, name: true },
  });
  for (const p of dbProviders) {
    providerIdByName.set(p.name.trim().toUpperCase(), p.id);
  }

  const report = {
    total: rows.length,
    skippedEmpty: 0,
    matched: 0,
    notFound: 0,
    updated: 0,
    marginsApplied: 0,
    categoriesAssigned: 0,
    categoriesCreated: 0,
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
    try {
      const rawSku = String(row["SKU"] ?? "").trim();
      const description = String(row["DESCRIPCION"] ?? "").trim();
      const providerName = String(row["PROVEEDOR"] ?? "").trim();
      const marginRaw = row["MARGEN WEB %"];
      const categoryRaw = String(row["CATEGORIA"] ?? "").trim();
      const linkFoto = String(row["LINK FOTO"] ?? "").trim();

      if (!rawSku || rawSku === "#N/A") {
        report.skippedEmpty++;
        continue;
      }

      const provLabel = providerName || "(sin proveedor)";
      bump(provLabel, "total");

      // El SKU del Excel ES el publicationSku (ya viene con prefijo).
      const publicationSku = rawSku;

      // Si el proveedor del Excel mapea a uno conocido en DB, restringimos
      // el match a ese providerId para evitar cruces.
      const dbProviderName = EXCEL_TO_DB_PROVIDER[providerName.toUpperCase()];
      const providerIdScope = dbProviderName
        ? providerIdByName.get(dbProviderName.toUpperCase())
        : undefined;

      const margin = parseMargin(marginRaw);

      const catalogProduct = await prisma.catalogProduct.findFirst({
        where: {
          userId: user.id,
          publicationSku,
          ...(providerIdScope ? { providerId: providerIdScope } : {}),
        },
        include: { images: { where: { isPrimary: true }, take: 1 } },
      });

      if (!catalogProduct) {
        report.notFound++;
        report.notFoundSkus.push(`[${provLabel}] ${rawSku} — ${description}`);
        bump(provLabel, "notFound");
        continue;
      }

      report.matched++;
      bump(provLabel, "matched");

      // Datos comerciales a actualizar (NO tocamos sku ni supplier*).
      const updateData: Record<string, unknown> = {};

      if (margin != null) {
        updateData.manualMargin = margin;
        report.marginsApplied++;
      }

      if (categoryRaw) {
        const primary = categoryRaw.split(",")[0].trim();
        if (primary) {
          const key = primary.toUpperCase();
          let categoryId = categoryCache.get(key);
          if (!categoryId) {
            const existing = await prisma.category.findFirst({
              where: { name: { equals: primary, mode: "insensitive" } },
              select: { id: true },
            });
            if (existing) {
              categoryId = existing.id;
            } else {
              const created = await prisma.category.create({
                data: { name: primary },
                select: { id: true },
              });
              categoryId = created.id;
              report.categoriesCreated++;
              console.log(`  ✚ Categoría creada: ${primary}`);
            }
            categoryCache.set(key, categoryId);
          }
          updateData.assignedCategoryId = categoryId;
          report.categoriesAssigned++;
        }
      }

      if (Object.keys(updateData).length > 0) {
        await prisma.catalogProduct.update({
          where: { id: catalogProduct.id },
          data: updateData,
        });
        report.updated++;
      }

      // Imagen primaria desde la URL del Excel si el producto no tiene una.
      if (linkFoto && !catalogProduct.images[0]) {
        await prisma.catalogProductImage.create({
          data: {
            catalogProductId: catalogProduct.id,
            url: linkFoto,
            position: 0,
            isPrimary: true,
            source: "USER",
            altText: description || null,
          },
        });
        report.imagesAdded++;
      }
    } catch (err) {
      report.errors.push(
        `${row["SKU"]}: ${err instanceof Error ? err.message : String(err)}`
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
  console.log(`Márgenes aplicados:     ${report.marginsApplied}`);
  console.log(`Categorías asignadas:   ${report.categoriesAssigned}`);
  console.log(`Categorías creadas:     ${report.categoriesCreated}`);
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
