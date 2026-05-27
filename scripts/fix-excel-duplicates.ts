// Resuelve los 3 duplicados de SKU proveedor que el cliente puso en el Excel.
// Decisión del cliente:
//   1. EF46  → eliminar (queda 1000 sobre IMPOTEKNO sku=2343)
//   2. EF37  → eliminar (queda EF36 sobre IMPOTEKNO sku=QR-91028)
//   3. JOR741 → eliminar (queda JOR635 sobre IMPOTEKNO sku=SV-628)
//
// En todos: desligar EventLog.productId antes de eliminar CatalogProduct.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function unlinkEventLogProduct(
  tx: Pick<PrismaClient, "eventLog">,
  catalogProductId: string
) {
  await tx.eventLog.updateMany({
    where: { productId: catalogProductId },
    data: { productId: null },
  });
}

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: "admin@pricecom.com" },
    select: { id: true },
  });
  if (!user) throw new Error("admin@pricecom.com no encontrado");

  const store = await prisma.store.findFirst({
    where: { userId: user.id },
    select: { id: true },
  });
  if (!store) throw new Error("no store");

  // ════════════════════════════════════════════════════════════════════
  // Caso 1 — EF46 eliminar; 1000 queda
  // ════════════════════════════════════════════════════════════════════
  console.log("─── Caso 1: EF46 ───");
  const impCp1000 = await prisma.catalogProduct.findFirst({
    where: {
      userId: user.id,
      sku: "2343",
      provider: { name: "IMPOTEKNO" },
    },
    include: { publications: true },
  });
  const miStock1000 = await prisma.catalogProduct.findFirst({
    where: {
      userId: user.id,
      sku: "1000",
      provider: { providerType: "OWN_STOCK" },
    },
    include: { publications: true },
  });

  if (!impCp1000) throw new Error("IMPOTEKNO sku=2343 no encontrado");
  if (!miStock1000) throw new Error("Mi stock sku=1000 no encontrado");

  const ef46Pub = impCp1000.publications.find((p) => p.externalSku === "EF46");
  const miStockPub = miStock1000.publications[0];

  if (!ef46Pub) throw new Error("Publication de EF46 (en IMPOTEKNO 2343) no encontrada");
  if (!miStockPub) throw new Error("Publication de Mi stock 1000 no encontrada");

  console.log(`  Borrar pub EF46:        ${ef46Pub.id} (woo=${ef46Pub.externalProductId})`);
  console.log(`  Reasignar pub 1000:     ${miStockPub.id} (woo=${miStockPub.externalProductId})`);
  console.log(`  Borrar Mi stock CP:     ${miStock1000.id}`);

  await prisma.$transaction(async (tx) => {
    // 1. Borrar la publication EF46 (desligar eventLogs primero).
    await tx.eventLog.updateMany({
      where: { publicationId: ef46Pub.id },
      data: { publicationId: null },
    });
    await tx.productPublication.delete({ where: { id: ef46Pub.id } });

    // 2. Reasignar la publication de Mi stock al CP IMPOTEKNO.
    await tx.productPublication.update({
      where: { id: miStockPub.id },
      data: { catalogProductId: impCp1000.id },
    });

    // 3. Desligar eventLogs del Mi stock CP y borrarlo.
    await unlinkEventLogProduct(tx, miStock1000.id);
    await tx.catalogProduct.delete({ where: { id: miStock1000.id } });
  });

  // 4. Marcar unmatched EF46 como resolved.
  const r1 = await prisma.unmatchedStoreProduct.updateMany({
    where: { storeId: store.id, externalSku: "EF46" },
    data: { resolved: true },
  });
  console.log(`  ✓ aplicado · unmatched EF46 resueltos=${r1.count}\n`);

  // ════════════════════════════════════════════════════════════════════
  // Caso 2 — EF37 eliminar; EF36 queda
  // ════════════════════════════════════════════════════════════════════
  console.log("─── Caso 2: EF37 ───");
  const impCpQr = await prisma.catalogProduct.findFirst({
    where: {
      userId: user.id,
      sku: "QR-91028",
      provider: { name: "IMPOTEKNO" },
    },
    include: { publications: true },
  });
  if (!impCpQr) throw new Error("IMPOTEKNO sku=QR-91028 no encontrado");
  const qrPub = impCpQr.publications[0];

  console.log(`  CP IMPOTEKNO QR-91028:  pubSku ${impCpQr.publicationSku} → EF36`);
  if (qrPub) {
    console.log(`  Publication ya está:    woo=${qrPub.externalProductId} extSku=${qrPub.externalSku} (no cambia)`);
  }

  await prisma.catalogProduct.update({
    where: { id: impCpQr.id },
    data: { publicationSku: "EF36" },
  });
  if (qrPub) {
    // Defensive: garantizar el match aunque ya esté así.
    await prisma.productPublication.update({
      where: { id: qrPub.id },
      data: { externalProductId: "6830", externalSku: "EF36" },
    });
  }
  const r2 = await prisma.unmatchedStoreProduct.updateMany({
    where: { storeId: store.id, externalSku: "EF37" },
    data: { resolved: true },
  });
  console.log(`  ✓ aplicado · unmatched EF37 resueltos=${r2.count}\n`);

  // ════════════════════════════════════════════════════════════════════
  // Caso 3 — JOR741 eliminar; JOR635 queda
  // ════════════════════════════════════════════════════════════════════
  console.log("─── Caso 3: JOR741 ───");
  const impCpSv = await prisma.catalogProduct.findFirst({
    where: {
      userId: user.id,
      sku: "SV-628",
      provider: { name: "IMPOTEKNO" },
    },
    include: { publications: true },
  });
  if (!impCpSv) throw new Error("IMPOTEKNO sku=SV-628 no encontrado");
  const svPub = impCpSv.publications[0];

  console.log(`  CP IMPOTEKNO SV-628:    pubSku ${impCpSv.publicationSku} → JOR635`);
  if (svPub) {
    console.log(`  Publication ya está:    woo=${svPub.externalProductId} extSku=${svPub.externalSku} (no cambia)`);
  }

  await prisma.catalogProduct.update({
    where: { id: impCpSv.id },
    data: { publicationSku: "JOR635" },
  });
  if (svPub) {
    await prisma.productPublication.update({
      where: { id: svPub.id },
      data: { externalProductId: "8098", externalSku: "JOR635" },
    });
  }
  const r3 = await prisma.unmatchedStoreProduct.updateMany({
    where: { storeId: store.id, externalSku: "JOR741" },
    data: { resolved: true },
  });
  console.log(`  ✓ aplicado · unmatched JOR741 resueltos=${r3.count}\n`);

  // Verificación final.
  console.log("─── Verificación ───");
  for (const [label, skus] of [
    ["1000 / EF46", ["1000", "EF46", "2343"]],
    ["EF36 / EF37", ["EF36", "EF37", "QR-91028"]],
    ["JOR635 / JOR741", ["JOR635", "JOR741", "SV-628"]],
  ] as const) {
    console.log(`\n  ${label}:`);
    const cps = await prisma.catalogProduct.findMany({
      where: {
        userId: user.id,
        OR: [{ sku: { in: skus } }, { publicationSku: { in: skus } }],
      },
      include: {
        provider: { select: { name: true, providerType: true } },
        publications: {
          select: { externalProductId: true, externalSku: true, status: true },
        },
      },
    });
    for (const cp of cps) {
      console.log(
        `    ${cp.provider.providerType.padEnd(10)} ${cp.provider.name.padEnd(10)} sku=${cp.sku} pubSku=${cp.publicationSku}`
      );
      for (const p of cp.publications) {
        console.log(
          `      pub: woo=${p.externalProductId} extSku=${p.externalSku} status=${p.status}`
        );
      }
    }
  }
}

main()
  .catch((e) => {
    console.error("ERROR:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
