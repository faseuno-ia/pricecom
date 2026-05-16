// Importador del Excel de la tienda existente del cliente.
//
// Match por SKU normalizado (sin prefijo de proveedor) dentro del scope del usuario.
// Setea publicationSku = prefix + supplierSku, manualMargin, categoría asignada y
// — si el producto no tiene imagen primaria — agrega la URL del Excel como
// CatalogProductImage source=USER.
//
// Uso:
//   npm run import:store-excel
//   npm run import:store-excel -- ruta/al/archivo.xlsx
//
// NO toca supplier* (sólo el worker los actualiza).

import * as XLSX from "xlsx";
import { PrismaClient } from "@prisma/client";
import path from "path";
import fs from "fs";

const prisma = new PrismaClient();

// Prefijos conocidos por proveedor (nombre normalizado upper → prefix con guión).
const PROVIDER_PREFIXES: Record<string, string> = {
  BAZAR380: "B380-",
  "BAZAR 380": "B380-",
  IMPOTEKNO: "IMPTK-",
  TOYPALACE: "TP-",
  TOYSPALACE: "TP-",
  "TOYS PALACE": "TP-",
  LACHIPELU: "LP-",
};

function normalizeSkuForMatch(sku: string): string {
  const s = String(sku).trim();
  for (const prefix of Object.values(PROVIDER_PREFIXES)) {
    if (s.toUpperCase().startsWith(prefix.toUpperCase())) {
      return s.slice(prefix.length).trim();
    }
  }
  return s;
}

function getPrefixForProvider(providerName: string): string {
  const key = providerName?.trim().toUpperCase();
  return PROVIDER_PREFIXES[key] ?? "";
}

function parseMargin(raw: unknown): number | null {
  if (raw == null || raw === "" || raw === "#N/A") return null;
  // Puede venir como número (0.35 = 35%) o como string "35%" / "35".
  if (typeof raw === "number") {
    // Si es ≤ 1 asumimos que es fracción y lo pasamos a porcentaje.
    return raw <= 1 && raw > 0 ? raw * 100 : raw;
  }
  const cleaned = String(raw).replace("%", "").replace(",", ".").trim();
  const n = Number(cleaned);
  if (!Number.isFinite(n)) return null;
  return n <= 1 && n > 0 ? n * 100 : n;
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
  console.log(`Filas encontradas: ${rows.length}`);

  // Único usuario (admin) — el sistema es mono-cliente por ahora.
  const user = await prisma.user.findFirst({
    select: { id: true, email: true },
  });
  if (!user) throw new Error("No hay usuarios en la DB");
  console.log(`Usuario: ${user.email}`);

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
  };

  // Cache de categorías ya resueltas/creadas en esta corrida (case-insensitive key).
  const categoryCache = new Map<string, string>(); // nameUpper → id

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

      const normalizedSku = normalizeSkuForMatch(rawSku);
      const prefix = getPrefixForProvider(providerName);
      const publicationSku = prefix + normalizedSku;

      const margin = parseMargin(marginRaw);

      const catalogProduct = await prisma.catalogProduct.findFirst({
        where: { userId: user.id, sku: normalizedSku },
        include: { images: { where: { isPrimary: true }, take: 1 } },
      });

      if (!catalogProduct) {
        report.notFound++;
        report.notFoundSkus.push(`${rawSku} (${description})`);
        continue;
      }

      report.matched++;

      const updateData: Record<string, unknown> = { publicationSku };

      if (margin != null) {
        updateData.manualMargin = margin;
        report.marginsApplied++;
      }

      if (categoryRaw) {
        // Si vienen varias separadas por coma, tomamos la primera.
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

      await prisma.catalogProduct.update({
        where: { id: catalogProduct.id },
        data: updateData,
      });
      report.updated++;

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
