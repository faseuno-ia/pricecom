// One-off: eliminar el duplicado JOR632 de Mi stock (Woo id 8095).
// El producto equivalente JOR218 vive en IMPOTEKNO (sku=TMCC327, Woo id 7228)
// y queda como única publicación.
//
// Pasos:
//   1. Resolver el ProductPublication de Mi stock JOR632.
//   2. DELETE en WooCommerce con force=true.
//   3. Borrar ProductPublication + CatalogProduct en PricEcom (transacción).

import { PrismaClient } from "@prisma/client";
import { WooCommerceClient } from "../lib/integrations/woocommerce/client";

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: "admin@pricecom.com" },
    select: { id: true },
  });
  if (!user) throw new Error("admin@pricecom.com no encontrado");

  const product = await prisma.catalogProduct.findFirst({
    where: {
      sku: "JOR632",
      userId: user.id,
      provider: { providerType: "OWN_STOCK" },
    },
    include: { publications: true },
  });
  if (!product) throw new Error("JOR632 Mi stock no encontrado");
  if (product.publications.length !== 1) {
    throw new Error(
      `Esperaba 1 publication, hay ${product.publications.length}`
    );
  }
  const pub = product.publications[0];
  console.log(`JOR632 Mi stock encontrado:`);
  console.log(`  catalogProduct: ${product.id}`);
  console.log(`  publication:    ${pub.id}`);
  console.log(`  woo product id: ${pub.externalProductId}`);
  console.log(`  store:          ${pub.storeId}\n`);

  const store = await prisma.store.findFirst({
    where: { id: pub.storeId, userId: user.id },
    include: { integrations: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  const integration = store?.integrations[0];
  if (!store || !integration) throw new Error("Store/integration no encontrado");

  const client = WooCommerceClient.fromIntegration({
    storeUrl: store.url,
    consumerKeyEncrypted: integration.consumerKeyEncrypted,
    consumerSecretEncrypted: integration.consumerSecretEncrypted,
  });

  const wooId = Number(pub.externalProductId);
  if (!Number.isFinite(wooId)) {
    throw new Error(`externalProductId no numérico: ${pub.externalProductId}`);
  }

  console.log(`→ DELETE /products/${wooId}?force=true`);
  const deleted = await client.deleteProduct(wooId, true);
  console.log(`✓ Woo respondió OK — producto eliminado:`);
  console.log(`    id=${deleted.id} sku=${deleted.sku} name="${deleted.name}"\n`);

  console.log(`→ Borrando ProductPublication ${pub.id} + CatalogProduct ${product.id}`);
  await prisma.$transaction(async (tx) => {
    await tx.productPublication.delete({ where: { id: pub.id } });
    await tx.catalogProduct.delete({ where: { id: product.id } });
  });
  console.log(`✓ DB limpia\n`);

  // Sanity: ya no debe quedar nada con sku=JOR632 en Mi stock.
  const remaining = await prisma.catalogProduct.findMany({
    where: { sku: "JOR632", userId: user.id, provider: { providerType: "OWN_STOCK" } },
  });
  console.log(`Verificación: JOR632 Mi stock restantes = ${remaining.length}`);

  // Sanity: JOR218/TMCC327 en IMPOTEKNO intacto.
  const intact = await prisma.catalogProduct.findFirst({
    where: {
      sku: "TMCC327",
      userId: user.id,
      provider: { name: "IMPOTEKNO" },
    },
    include: { publications: true },
  });
  if (intact) {
    const p = intact.publications[0];
    console.log(
      `IMPOTEKNO TMCC327 (pubSku=${intact.publicationSku}) intacto: woo=${p?.externalProductId} status=${p?.status}`
    );
  }
}

main()
  .catch((e) => {
    console.error("ERROR:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
