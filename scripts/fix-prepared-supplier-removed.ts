// Script idempotente. Encuentra CatalogProducts en estado contradictorio:
//   supplierStatus = SUPPLIER_REMOVED + internalStatus = PREPARED + stockSource = SUPPLIER
// y los baja a PAUSED, marcando además sus ProductPublication ACTIVE como
// pendingSync para que el próximo /sync/publications los baje a draft en Woo.
//
// Se puede correr varias veces sin riesgo: al final del primer run no quedan
// productos en ese estado, así que las siguientes ejecuciones son no-op.
//
// Uso:
//   npm run fix:prepared-removed
//   o equivalente: npx tsx scripts/fix-prepared-supplier-removed.ts

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  // Elegimos el usuario con más catalogProducts (memoria: hay un admin@example.com
  // vacío que findFirst toma por error).
  const users = await prisma.user.findMany({
    select: {
      id: true,
      email: true,
      _count: { select: { catalogProducts: true } },
    },
  });
  const user = users.sort(
    (a, b) => b._count.catalogProducts - a._count.catalogProducts
  )[0];
  if (!user) {
    console.log("Sin usuarios.");
    return;
  }
  console.log(`Usando: ${user.email}`);

  const targets = await prisma.catalogProduct.findMany({
    where: {
      userId: user.id,
      supplierStatus: "SUPPLIER_REMOVED",
      internalStatus: "PREPARED",
      stockSource: "SUPPLIER",
    },
    select: { id: true, sku: true, publicationSku: true, supplierName: true },
  });

  console.log(`\nProductos en estado contradictorio: ${targets.length}`);
  if (targets.length === 0) {
    console.log("Nada que arreglar — todo limpio.");
    return;
  }

  targets.slice(0, 20).forEach((p) =>
    console.log(
      `  sku=${p.sku} pubSku=${p.publicationSku} · ${p.supplierName.slice(0, 50)}`
    )
  );
  if (targets.length > 20) console.log(`  …y ${targets.length - 20} más.`);

  const ids = targets.map((p) => p.id);

  const [productsUpdate, pubsUpdate] = await prisma.$transaction([
    prisma.catalogProduct.updateMany({
      where: { id: { in: ids } },
      data: { internalStatus: "PAUSED" },
    }),
    prisma.productPublication.updateMany({
      where: {
        catalogProductId: { in: ids },
        status: "ACTIVE",
      },
      data: { pendingSync: true, syncStatus: "PENDING_SYNC" },
    }),
  ]);

  console.log(`\n✓ CatalogProduct → PAUSED:                ${productsUpdate.count}`);
  console.log(`✓ ProductPublication marcadas pendingSync: ${pubsUpdate.count}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
