// One-off: eliminar las 3 ProductPublication huérfanas (EF27, EF106, EF23)
// que apuntan a Woo IDs ya borrados del admin del cliente. Confirmado con
// GET /products/{id} → 404 en los 3 casos.
//
// El CatalogProduct queda como está (PAUSED, supplierStatus=ACTIVE) —
// reflejaba la intención del usuario; no hay publication que reactivar.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const SKUS = ["EF27", "EF106", "EF23"];

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: "admin@pricecom.com" },
    select: { id: true },
  });
  if (!user) throw new Error("admin@pricecom.com no encontrado");

  const pubs = await prisma.productPublication.findMany({
    where: {
      pendingSync: true,
      catalogProduct: { is: { userId: user.id, sku: { in: SKUS } } },
    },
    select: {
      id: true,
      storeId: true,
      externalProductId: true,
      catalogProductId: true,
      catalogProduct: { select: { sku: true, internalStatus: true } },
    },
  });

  console.log(`Publications a eliminar: ${pubs.length}\n`);
  for (const p of pubs) {
    console.log(
      `  · ${p.catalogProduct.sku} pub=${p.id} woo=${p.externalProductId} (cat queda en ${p.catalogProduct.internalStatus})`
    );
  }
  console.log("");

  if (pubs.length === 0) {
    console.log("Nada que limpiar.");
    return;
  }

  // Limpieza por publication: borrar EventLog asociados (FK) + la publication
  // misma, en una transacción por id. Loguear un evento de cleanup desde el
  // catalog product (no la publication, que está por desaparecer).
  for (const p of pubs) {
    await prisma.$transaction(async (tx) => {
      // Soltar la FK de los eventLogs antes del delete.
      await tx.eventLog.updateMany({
        where: { publicationId: p.id },
        data: { publicationId: null },
      });
      await tx.productPublication.delete({ where: { id: p.id } });
      await tx.eventLog.create({
        data: {
          source: "USER",
          severity: "INFO",
          type: "PUBLICATION_DELETED_ORPHAN",
          title: `Publication huérfana eliminada — ${p.catalogProduct.sku}`,
          description: `El producto Woo ${p.externalProductId} no existe (404 confirmado). Publication local borrada.`,
          userId: user.id,
          storeId: p.storeId,
          productId: p.catalogProductId,
          metadata: {
            sku: p.catalogProduct.sku,
            deletedPublicationId: p.id,
            externalProductId: p.externalProductId,
          },
        },
      });
    });
    console.log(`  ✓ ${p.catalogProduct.sku} eliminada`);
  }

  // Verificación: sin publication pendientes para esos SKUs.
  const remaining = await prisma.productPublication.count({
    where: {
      catalogProduct: { is: { userId: user.id, sku: { in: SKUS } } },
    },
  });
  console.log(`\nVerificación: publications restantes para EF27/EF106/EF23 = ${remaining}`);

  // Y los CatalogProduct siguen ahí en PAUSED.
  const cats = await prisma.catalogProduct.findMany({
    where: { userId: user.id, sku: { in: SKUS } },
    select: { sku: true, internalStatus: true, supplierStatus: true },
  });
  for (const c of cats) {
    console.log(`  ${c.sku} → internal=${c.internalStatus} supplier=${c.supplierStatus}`);
  }
}

main()
  .catch((e) => {
    console.error("ERROR:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
