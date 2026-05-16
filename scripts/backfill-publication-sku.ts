// Recomputa publicationSku para todos los CatalogProduct existentes a partir
// del imageFilenamePrefix de su proveedor. Idempotente: solo actualiza filas
// cuyo valor calculado difiera del actual.
//
// Uso: npx tsx scripts/backfill-publication-sku.ts

import { PrismaClient } from "@prisma/client";
import { buildPublicationSku } from "../lib/catalog/publication-sku";

const prisma = new PrismaClient();

async function main() {
  // Prefijo por providerId (una sola consulta).
  const configs = await prisma.providerScraperConfig.findMany({
    select: { providerId: true, imageFilenamePrefix: true },
  });
  const prefixByProvider = new Map<string, string | null>();
  for (const c of configs) {
    prefixByProvider.set(c.providerId, c.imageFilenamePrefix ?? null);
  }

  console.log(`Proveedores con scraperConfig: ${configs.length}`);
  for (const c of configs) {
    console.log(`  ${c.providerId} → prefix="${c.imageFilenamePrefix ?? ""}"`);
  }

  // Iteramos por proveedor para no traer todo a memoria.
  const providers = await prisma.provider.findMany({ select: { id: true, name: true } });
  let totalUpdated = 0;
  let totalChecked = 0;

  for (const provider of providers) {
    const prefix = prefixByProvider.get(provider.id) ?? null;
    const products = await prisma.catalogProduct.findMany({
      where: { providerId: provider.id },
      select: { id: true, sku: true, publicationSku: true },
    });
    let updated = 0;
    for (const p of products) {
      const computed = buildPublicationSku(prefix, p.sku);
      if (computed !== p.publicationSku) {
        await prisma.catalogProduct.update({
          where: { id: p.id },
          data: { publicationSku: computed },
        });
        updated++;
      }
      totalChecked++;
    }
    totalUpdated += updated;
    console.log(
      `  ${provider.name.padEnd(22)} prefix="${prefix ?? ""}"  productos=${products.length}  actualizados=${updated}`
    );
  }

  console.log(`\n✓ Backfill completo. Revisados=${totalChecked}, actualizados=${totalUpdated}`);
}

main()
  .catch((err) => {
    console.error("Error:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
