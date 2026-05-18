// One-off: backfill de CatalogProductCategory a partir de assignedCategoryId
// existentes. Para productos que tenían una categoría primaria asignada antes
// de introducir la M2M, crea la fila correspondiente con isPrimary=true.
// Idempotente: filtra por `categories: { none: {} }`.
//
// Uso: npm run catalog:backfill-categories

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const products = await prisma.catalogProduct.findMany({
    where: {
      assignedCategoryId: { not: null },
      categories: { none: {} },
    },
    select: { id: true, assignedCategoryId: true },
  });

  console.log(`Productos a migrar: ${products.length}`);
  if (products.length === 0) {
    console.log("Nada que migrar.");
    return;
  }

  let ok = 0;
  let failed = 0;
  for (const p of products) {
    try {
      await prisma.catalogProductCategory.create({
        data: {
          catalogProductId: p.id,
          categoryId: p.assignedCategoryId!,
          isPrimary: true,
        },
      });
      ok++;
    } catch (err) {
      failed++;
      console.error(`  ✗ ${p.id}: ${(err as Error).message}`);
    }
  }

  console.log(`\n✓ Migrados: ${ok}${failed > 0 ? ` (${failed} fallaron)` : ""}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
