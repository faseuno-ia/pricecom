// One-off: pausar las 2 publications anómalas que quedaron de antes de los
// fixes de auto-pause + push inmediato.
//
//   Caso A: pub ACTIVE + supplier ACTIVE  + internal IGNORED
//           → usuario ignoró pero la pausa nunca se pusheó a Woo.
//   Caso B: pub ACTIVE + supplier SUPPLIER_REMOVED + internal PUBLISHED
//           → proveedor bajó el producto pero la auto-pausa no actuó.
//
// Para ambas: pauseProductInWoo (cambia pub.status=PAUSED + externalStatus=draft
// + push a Woo). Si el caso A no estaba ya internalStatus=PAUSED, lo dejamos en
// IGNORED (es la intención del usuario). El caso B sí lo pasamos a PAUSED.

import { PrismaClient } from "@prisma/client";
import { WooCommerceClient } from "../lib/integrations/woocommerce/client";
import { pauseProductInWoo } from "../lib/integrations/woocommerce/publication-service";

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: "admin@pricecom.com" },
    select: { id: true },
  });
  if (!user) throw new Error("admin@pricecom.com no encontrado");

  const store = await prisma.store.findFirst({
    where: { userId: user.id },
    include: { integrations: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  const integration = store?.integrations[0];
  if (!store || !integration) throw new Error("Store/integration faltante");

  const client = WooCommerceClient.fromIntegration({
    storeUrl: store.url,
    consumerKeyEncrypted: integration.consumerKeyEncrypted,
    consumerSecretEncrypted: integration.consumerSecretEncrypted,
  });

  // 1. Identificar las 2 anómalas.
  const anomalies = await prisma.productPublication.findMany({
    where: {
      storeId: store.id,
      status: "ACTIVE",
      OR: [
        { catalogProduct: { is: { internalStatus: "IGNORED" } } },
        { catalogProduct: { is: { supplierStatus: "SUPPLIER_REMOVED" } } },
      ],
    },
    include: {
      catalogProduct: {
        select: {
          id: true,
          sku: true,
          supplierName: true,
          supplierStatus: true,
          internalStatus: true,
          provider: { select: { name: true } },
        },
      },
    },
  });

  console.log(`Anómalas encontradas: ${anomalies.length}\n`);
  for (const a of anomalies) {
    const cp = a.catalogProduct;
    console.log(
      `  · ${cp.provider.name} ${cp.sku} · woo=${a.externalProductId}`
    );
    console.log(
      `    pub=${a.status} supplier=${cp.supplierStatus} internal=${cp.internalStatus}`
    );
    console.log(`    "${cp.supplierName.slice(0, 60)}"`);
  }
  console.log("");

  if (anomalies.length === 0) {
    console.log("Nada que pausar.");
    return;
  }

  // 2. Pausar cada una.
  let ok = 0;
  for (const a of anomalies) {
    const cp = a.catalogProduct;
    const res = await pauseProductInWoo(prisma, client, store.id, cp.id);
    if (res.success) {
      console.log(`  ✓ ${cp.provider.name} ${cp.sku} pausado en Woo`);
      ok++;
    } else {
      console.log(`  ✗ ${cp.provider.name} ${cp.sku} → ${res.error}`);
    }
  }
  console.log(`\nPausados OK: ${ok}/${anomalies.length}`);

  // 3. Verificar distribución después.
  const after = await prisma.$queryRaw<
    { status: string; supplierStatus: string; internalStatus: string; total: bigint }[]
  >`
    SELECT pp.status, cp."supplierStatus", cp."internalStatus", COUNT(*) as total
    FROM "ProductPublication" pp
    JOIN "CatalogProduct" cp ON cp.id = pp."catalogProductId"
    WHERE pp."storeId" = ${store.id}
      AND pp.status = 'ACTIVE'
      AND (cp."internalStatus" = 'IGNORED' OR cp."supplierStatus" = 'SUPPLIER_REMOVED')
    GROUP BY pp.status, cp."supplierStatus", cp."internalStatus"
  `;
  console.log(`\nVerificación: anómalas restantes = ${after.length === 0 ? 0 : after.reduce((a, r) => a + Number(r.total), 0)}`);
}

main()
  .catch((e) => {
    console.error("ERROR:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
