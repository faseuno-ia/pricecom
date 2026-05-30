// Resuelve la colisión TP-00658 detectada en el audit de Fase 0.
//
// Origen confirmado (línea de tiempo en EventLogs): el 2026-05-26 el cliente
// editó manualmente desde el drawer DURAVIT.publicationSku de "TP-658" a
// "TP-00658", lo cual hizo que el sync matcheara DURAVIT contra woo=10187
// (la pistola). El sync subsecuente CONTAMINÓ los datos en Woo con costo +
// SKU de DURAVIT (TP-658 / ~3302). Resultado:
//   - Woo 10187 tiene sku/price de DURAVIT pero foto/identidad de la pistola.
//   - PricEcom tiene 2 publications apuntando al mismo wooId.
//
// Corrección:
//   - PUT a Woo 10187: dejar sku=TP-00658, regular_price=48133 (los datos
//     correctos de la pistola: costo $37900 + 27% margen).
//   - UPDATE pub CP 2 (pistola): externalSku=TP-00658, priceInStore=48133.
//   - UPDATE pub CP 1 (DURAVIT): nulleamos wooId/extSku/etc, status=PAUSED.
//   - UPDATE CP 1: internalStatus=PAUSED, publicationSku=null.
//
// Dry-run por default. Aplicar con --apply.

const TARGET_SKU = "TP-00658";
const TARGET_PRICE = 48133;

import { PrismaClient } from "@prisma/client";
import { WooCommerceClient, type WooProduct } from "../lib/integrations/woocommerce/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: "admin@pricecom.com" },
    select: { id: true },
  });
  if (!user) throw new Error("no user");
  const store = await prisma.store.findFirst({
    where: { userId: user.id },
    include: { integrations: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (!store) throw new Error("no store");
  const integration = store.integrations[0];
  if (!integration) throw new Error("no integration");

  const wooClient = WooCommerceClient.fromIntegration({
    storeUrl: store.url,
    consumerKeyEncrypted: integration.consumerKeyEncrypted,
    consumerSecretEncrypted: integration.consumerSecretEncrypted,
  });

  console.log(APPLY ? "═══ MODO APPLY ═══\n" : "═══ DRY-RUN (sin escribir) ═══\n");

  // ─────────────────────────────────────────────────────────────
  // 1. Estado actual en Woo
  // ─────────────────────────────────────────────────────────────
  console.log("─── Estado actual en Woo (GET /products/10187) ───");
  const wooProduct: WooProduct | null = await wooClient.getProduct(10187);
  if (!wooProduct) {
    console.log("  ✗ Woo 10187 ya no existe — abortando, esto no es lo esperado");
    return;
  }
  console.log(`  id=${wooProduct.id} sku="${wooProduct.sku}"`);
  console.log(`  name="${wooProduct.name}"`);
  console.log(`  status=${wooProduct.status} price=${wooProduct.regular_price ?? wooProduct.price}`);

  // ─────────────────────────────────────────────────────────────
  // 2. Datos del último scrape para CP 2 (sku=00658) y CP 1 (sku=658)
  // ─────────────────────────────────────────────────────────────
  console.log("\n─── Latest scrape data: CP 2 (sku=00658, pistola) ───");
  const cp2 = await prisma.catalogProduct.findFirst({
    where: {
      userId: user.id,
      sku: "00658",
      provider: { name: "TOYS PALACE" },
    },
    include: {
      provider: { select: { name: true } },
      publications: true,
      latestExtractedProduct: true,
    },
  });
  if (!cp2) throw new Error("CP 2 (sku=00658) no encontrado");
  console.log(`  cp=${cp2.id}`);
  console.log(`  supplierName:    ${cp2.supplierName}`);
  console.log(`  wholesalePrice:  ${cp2.wholesalePrice ?? "—"}`);
  console.log(`  finalPrice (PE): ${cp2.finalPrice ?? "—"}`);
  console.log(`  lastSeenAt:      ${cp2.lastSeenAt?.toISOString()}`);
  console.log(`  productUrl:      ${cp2.productUrl ?? "—"}`);
  console.log(`  imageUrl:        ${cp2.imageUrl ?? "—"}`);
  if (cp2.latestExtractedProduct) {
    const e = cp2.latestExtractedProduct;
    console.log(`  ext.name:        ${e.name}`);
    console.log(`  ext.price:       ${e.wholesalePrice ?? "—"}`);
    console.log(`  ext.extractedAt: ${e.extractedAt.toISOString()}`);
  }
  const cp2Pub = cp2.publications[0];
  console.log(`  publication:`);
  console.log(`    id=${cp2Pub.id}`);
  console.log(`    externalProductId: ${cp2Pub.externalProductId}`);
  console.log(`    externalSku:       ${cp2Pub.externalSku}`);
  console.log(`    priceInStore:      ${cp2Pub.priceInStore}`);
  console.log(`    status:            ${cp2Pub.status}`);

  console.log("\n─── Latest scrape data: CP 1 (sku=658, DURAVIT) ───");
  const cp1 = await prisma.catalogProduct.findFirst({
    where: {
      userId: user.id,
      sku: "658",
      provider: { name: "TOYS PALACE" },
    },
    include: {
      provider: { select: { name: true } },
      publications: true,
      latestExtractedProduct: true,
    },
  });
  if (!cp1) throw new Error("CP 1 (sku=658) no encontrado");
  console.log(`  cp=${cp1.id}`);
  console.log(`  supplierName:    ${cp1.supplierName}`);
  console.log(`  wholesalePrice:  ${cp1.wholesalePrice ?? "—"}`);
  console.log(`  lastSeenAt:      ${cp1.lastSeenAt?.toISOString()}`);
  console.log(`  publicationSku:  ${cp1.publicationSku}`);
  const cp1Pub = cp1.publications[0];
  console.log(`  publication:`);
  console.log(`    id=${cp1Pub.id}`);
  console.log(`    externalProductId: ${cp1Pub.externalProductId} ← apunta a la pistola, ERRÓNEO`);
  console.log(`    externalSku:       ${cp1Pub.externalSku}`);
  console.log(`    priceInStore:      ${cp1Pub.priceInStore}`);
  console.log(`    status:            ${cp1Pub.status}`);

  // ─────────────────────────────────────────────────────────────
  // 3. Acción 2 — PUT a Woo 10187 con datos correctos de la pistola
  // ─────────────────────────────────────────────────────────────
  console.log("\n─── Acción 2 (PUT a Woo 10187): diff vs target ───");
  const currentWooPrice = Number(wooProduct.regular_price ?? wooProduct.price);
  const wooPut: { sku?: string; regular_price?: string; name?: string } = {};
  if (wooProduct.sku !== TARGET_SKU) {
    wooPut.sku = TARGET_SKU;
    console.log(`  sku:            "${wooProduct.sku}" → "${TARGET_SKU}"`);
  } else {
    console.log(`  sku:            "${wooProduct.sku}" (sin cambio)`);
  }
  if (currentWooPrice !== TARGET_PRICE) {
    wooPut.regular_price = TARGET_PRICE.toFixed(2);
    console.log(`  regular_price:  ${currentWooPrice} → ${TARGET_PRICE}`);
  } else {
    console.log(`  regular_price:  ${currentWooPrice} (sin cambio)`);
  }
  // Name: el actual ya describe la pistola ("PISTOLA GIGANTE LANZA DARDOS …").
  // No lo pisamos a "JYF PISTOLA LANZA DARDO TIPO NERF" (= supplierName del
  // proveedor) porque el cliente puede haberlo redactado a propósito como
  // título comercial. Si querés sobrescribirlo, lo agregamos a wooPut.name.
  const looksLikePistola = wooProduct.name.toLowerCase().includes("pistola");
  console.log(
    `  name:           "${wooProduct.name}" (sin cambio${
      looksLikePistola ? " — ya describe la pistola" : " — ⚠ no parece la pistola"
    })`
  );
  console.log(`  → PUT payload: ${JSON.stringify(wooPut)}`);
  if (Object.keys(wooPut).length === 0) {
    console.log(`  (no-op — Woo ya está sincronizado con target)`);
  }

  // ─────────────────────────────────────────────────────────────
  // 4. Plan de UPDATEs en PricEcom
  // ─────────────────────────────────────────────────────────────
  // priceInStore refleja el precio que el cliente quiere en Woo (post-fix).
  // Tras el PUT, Woo va a tener regular_price=48133, así que la publication
  // queda consistente con priceInStore=48133.
  const newCp2ExternalSku = TARGET_SKU;
  const newCp2PriceInStore = TARGET_PRICE;

  console.log("\n─── Acción 1 (UPDATE publication de CP 2 — pistola) ───");
  console.log(`  pub=${cp2Pub.id}`);
  const changesCp2: string[] = [];
  if (cp2Pub.externalSku !== newCp2ExternalSku) {
    changesCp2.push(`externalSku:  "${cp2Pub.externalSku}" → "${newCp2ExternalSku}"`);
  }
  if (cp2Pub.priceInStore !== newCp2PriceInStore) {
    changesCp2.push(`priceInStore: ${cp2Pub.priceInStore} → ${newCp2PriceInStore}`);
  }
  if (changesCp2.length === 0) {
    console.log(`  (sin cambios)`);
  } else {
    for (const c of changesCp2) console.log(`    ${c}`);
  }

  console.log("\n─── Acción 3 (UPDATE publication de CP 1 — DURAVIT) ───");
  console.log(`  pub=${cp1Pub.id}`);
  console.log(`    externalProductId: "${cp1Pub.externalProductId}" → null`);
  console.log(`    externalSku:       "${cp1Pub.externalSku}" → null`);
  console.log(`    externalUrl:       ${cp1Pub.externalUrl ?? "—"} → null`);
  console.log(`    priceInStore:      ${cp1Pub.priceInStore} → null`);
  console.log(`    status:            ${cp1Pub.status} → PAUSED`);
  console.log(`    pausedAt:          ${cp1Pub.pausedAt?.toISOString() ?? "—"} → now()`);
  console.log(`    pendingSync:       ${cp1Pub.pendingSync} → false`);
  console.log(`    syncStatus:        ${cp1Pub.syncStatus} → SYNCED`);

  console.log("\n─── Acción 4 (UPDATE CP 1 — DURAVIT) ───");
  console.log(`  cp=${cp1.id}`);
  console.log(`    internalStatus: ${cp1.internalStatus} → PAUSED`);
  console.log(`    publicationSku: "${cp1.publicationSku}" → null  (coherente con flujo lazy)`);

  console.log("\n─── Acción 5 (EventLog) ───");
  console.log(`  type: PUBLICATION_RELINKED`);
  console.log(`  title: "Colisión TP-00658 resuelta — DURAVIT desvinculado de woo=10187"`);
  console.log(
    `  metadata: { wooId: 10187, kept: cp=${cp2.id} (JYF PISTOLA), unlinked: cp=${cp1.id} (DURAVIT TORRE MINI) }`
  );

  if (!APPLY) {
    console.log("\n→ Dry-run. Re-correr con --apply para escribir.");
    return;
  }

  // ─────────────────────────────────────────────────────────────
  // APPLY — primero Woo (irreversible), después DB en transacción.
  // ─────────────────────────────────────────────────────────────
  console.log("\n─── Aplicando ───");

  // Paso 1: corregir Woo. Si esto falla, abortamos antes de tocar la DB para
  // no quedar con un estado inconsistente (DB limpia pero Woo contaminado).
  if (Object.keys(wooPut).length > 0) {
    console.log(`  → PUT Woo 10187 ${JSON.stringify(wooPut)}`);
    const updated = await wooClient.updateProduct(10187, wooPut);
    console.log(
      `  ✓ Woo actualizado: sku=${updated.sku} regular_price=${updated.regular_price} name="${updated.name}"`
    );
  } else {
    console.log(`  · Woo ya está sincronizado (no PUT)`);
  }

  // Paso 2: transacción DB.
  await prisma.$transaction(async (tx) => {
    // Acción 1
    if (changesCp2.length > 0) {
      await tx.productPublication.update({
        where: { id: cp2Pub.id },
        data: {
          externalSku: newCp2ExternalSku,
          priceInStore: newCp2PriceInStore,
        },
      });
    }
    // Acción 3
    await tx.productPublication.update({
      where: { id: cp1Pub.id },
      data: {
        externalProductId: null,
        externalSku: null,
        externalUrl: null,
        priceInStore: null,
        status: "PAUSED",
        pausedAt: new Date(),
        pendingSync: false,
        syncStatus: "SYNCED",
      },
    });
    // Acción 4
    await tx.catalogProduct.update({
      where: { id: cp1.id },
      data: { internalStatus: "PAUSED", publicationSku: null },
    });
    // Acción 5
    await tx.eventLog.create({
      data: {
        source: "USER",
        severity: "INFO",
        type: "PUBLICATION_RELINKED",
        title: "Colisión TP-00658 resuelta — DURAVIT desvinculado de woo=10187",
        description:
          "Causa raíz: edición manual de publicationSku el 2026-05-26 contaminó " +
          "el match con woo=10187 y los sync subsecuentes propagaron datos de " +
          "DURAVIT (sku TP-658, $3302) al producto pistola en Woo. Se corrigió " +
          "Woo (sku=TP-00658, price=48133), se desligó la publication de DURAVIT.",
        userId: user.id,
        storeId: store.id,
        metadata: {
          wooId: 10187,
          wooPut,
          kept: { cpId: cp2.id, name: cp2.supplierName },
          unlinked: { cpId: cp1.id, name: cp1.supplierName },
        },
      },
    });
  });
  console.log("✓ Aplicado.");
}

main()
  .catch((e) => {
    console.error("ERROR:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
