// One-off: dedupe 8 productos que viven duplicados entre Mi stock y un
// proveedor real (7 IMPOTEKNO + 1 GABY). Mismo patrón que el fix manual de
// VAR-CAL-CH100:
//
//   1. Encontrar la publication ACTIVE del producto Mi stock (woo_id real).
//   2. Encontrar el CatalogProduct del proveedor (match por supplierName).
//   3. Si el proveedor tiene una publication fantasma (externalProductId NULL)
//      → borrarla primero.
//   4. Reasignar la publication: catalogProductId → producto del proveedor.
//   5. Actualizar el producto del proveedor:
//        - publicationSku = SKU actual de Mi stock (el que el cliente usa en
//          Woo, p.ej. "JOR1043"). Esto es lo que garantiza que el próximo
//          scrape matchee correctamente.
//        - internalStatus = PUBLISHED.
//        - finalPrice / manualMargin: preservar los de Mi stock si existían
//          (el usuario los seteó manualmente).
//   6. Borrar el CatalogProduct huérfano de Mi stock.
//
// Por defecto corre en dry-run. Para aplicar: --apply.
//
// uso:
//   npx tsx scripts/dedupe-mistock-vs-providers.ts          # dry-run
//   npx tsx scripts/dedupe-mistock-vs-providers.ts --apply  # ejecuta

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

const DEDUPES = [
  { ownSku: "JOR1043", provSku: "HT-2701", provName: "IMPOTEKNO" },
  { ownSku: "JOR1079", provSku: "HOG0382", provName: "IMPOTEKNO" },
  { ownSku: "JOR1087", provSku: "ILU0155", provName: "IMPOTEKNO" },
  { ownSku: "JOR540", provSku: "DU1159", provName: "IMPOTEKNO" },
  { ownSku: "JOR594", provSku: "C0030", provName: "IMPOTEKNO" },
  { ownSku: "JOR620", provSku: "JG-988", provName: "GABY" },
  { ownSku: "JOR756", provSku: "150GR", provName: "IMPOTEKNO" },
  { ownSku: "TEK-HMF-91073", provSku: "HMF-91073", provName: "IMPOTEKNO" },
];

async function main() {
  console.log(
    APPLY
      ? "MODO: APLICAR cambios"
      : "MODO: DRY-RUN (sin cambios). Usar --apply para ejecutar.\n"
  );

  const user = await prisma.user.findUnique({
    where: { email: "admin@pricecom.com" },
    select: { id: true },
  });
  if (!user) throw new Error("admin@pricecom.com no existe");

  let ok = 0;
  let skipped = 0;
  const errors: string[] = [];

  for (const dd of DEDUPES) {
    console.log(`\n─── ${dd.ownSku} → ${dd.provName} ${dd.provSku} ───`);

    // 1. CatalogProduct de Mi stock + su publication ACTIVE.
    const ownProduct = await prisma.catalogProduct.findFirst({
      where: {
        sku: dd.ownSku,
        userId: user.id,
        provider: { providerType: "OWN_STOCK" },
      },
      include: {
        publications: { where: { status: "ACTIVE" } },
      },
    });
    if (!ownProduct) {
      const msg = `  ✗ Mi stock no encontrado: ${dd.ownSku}`;
      console.log(msg);
      errors.push(msg);
      continue;
    }
    if (ownProduct.publications.length !== 1) {
      const msg = `  ✗ Esperaba 1 publication ACTIVE en Mi stock, hay ${ownProduct.publications.length}`;
      console.log(msg);
      errors.push(msg);
      continue;
    }
    const pub = ownProduct.publications[0];
    console.log(
      `  Mi stock pub: id=${pub.id} woo=${pub.externalProductId} extSku=${pub.externalSku}`
    );

    // 2. CatalogProduct del proveedor (match por sku + provider).
    const provProduct = await prisma.catalogProduct.findFirst({
      where: {
        sku: dd.provSku,
        userId: user.id,
        provider: { name: dd.provName },
      },
      include: { publications: true },
    });
    if (!provProduct) {
      const msg = `  ✗ Proveedor no encontrado: ${dd.provName} ${dd.provSku}`;
      console.log(msg);
      errors.push(msg);
      continue;
    }
    console.log(
      `  Proveedor: id=${provProduct.id} pubSku=${provProduct.publicationSku} estado=${provProduct.internalStatus}`
    );

    // 3. Detectar publications fantasma en el proveedor.
    const ghostPubs = provProduct.publications.filter(
      (p) => p.externalProductId === null
    );
    const realPubs = provProduct.publications.filter(
      (p) => p.externalProductId !== null
    );
    if (realPubs.length > 0) {
      const msg = `  ✗ Proveedor ya tiene publication real (${realPubs[0].externalProductId}) — abortar este caso, requiere review manual`;
      console.log(msg);
      errors.push(msg);
      continue;
    }
    if (ghostPubs.length > 0) {
      console.log(`  · ${ghostPubs.length} publication(s) fantasma a borrar`);
    }

    // 4-6. Aplicar (transacción).
    if (APPLY) {
      try {
        await prisma.$transaction(async (tx) => {
          // Borrar fantasmas del proveedor (si las hay).
          for (const g of ghostPubs) {
            await tx.productPublication.delete({ where: { id: g.id } });
          }
          // Reasignar la publication.
          await tx.productPublication.update({
            where: { id: pub.id },
            data: { catalogProductId: provProduct.id },
          });
          // Actualizar el producto del proveedor.
          await tx.catalogProduct.update({
            where: { id: provProduct.id },
            data: {
              publicationSku: dd.ownSku,
              internalStatus: "PUBLISHED",
              // Preservar precio/margen seteados por el usuario en Mi stock.
              finalPrice: ownProduct.finalPrice ?? provProduct.finalPrice,
              manualMargin:
                ownProduct.manualMargin ?? provProduct.manualMargin,
            },
          });
          // Borrar el CatalogProduct huérfano (Mi stock).
          await tx.catalogProduct.delete({ where: { id: ownProduct.id } });
        });
        console.log(`  ✓ aplicado`);
        ok++;
      } catch (e) {
        const msg = `  ✗ Error al aplicar: ${e instanceof Error ? e.message : e}`;
        console.log(msg);
        errors.push(msg);
      }
    } else {
      console.log(`  → reasignar pub ${pub.id} → catalogProduct ${provProduct.id}`);
      console.log(`  → set publicationSku=${dd.ownSku}, internalStatus=PUBLISHED en proveedor`);
      console.log(`  → eliminar CatalogProduct Mi stock ${ownProduct.id}`);
      ok++;
    }
  }

  console.log(`\n${"=".repeat(50)}`);
  console.log(`${APPLY ? "Aplicados" : "Plan OK"}: ${ok}/${DEDUPES.length}`);
  if (skipped) console.log(`Saltados: ${skipped}`);
  if (errors.length) {
    console.log(`\nErrores/warnings:`);
    for (const e of errors) console.log(`  ${e}`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
