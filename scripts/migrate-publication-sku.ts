// FASE 2 lazy SKU — migra CatalogProduct.publicationSku → ProductPublication.sku
// para los casos limpios (caso A del audit: wooId != null + publicationSku != null).
//
// Reglas (per spec):
//   - wooId != null + publicationSku != null  →  copy a ProductPublication.sku
//   - wooId != null + publicationSku == null  →  log como "requiere asignación
//                                                  manual", dejar sku = null
//   - wooId == null                            →  dejar sku = null (flujo lazy)
//
// IDEMPOTENTE: si ProductPublication.sku ya tiene valor, NO lo sobreescribe.
// Re-correr el script no hace nada salvo reportar 0 migraciones.
//
// Por default es DRY-RUN. Aplicar con --apply (escribe dentro de una
// transacción por chunks).

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");
const CHUNK_SIZE = 100;

async function main() {
  console.log(
    APPLY
      ? "═══ MODO APPLY (escribe en DB dentro de transacción) ═══\n"
      : "═══ DRY-RUN (sin escribir). Usar --apply para ejecutar. ═══\n"
  );

  const user = await prisma.user.findUnique({
    where: { email: "admin@pricecom.com" },
    select: { id: true },
  });
  if (!user) throw new Error("admin@pricecom.com no encontrado");

  // Cargar TODAS las publications con su CatalogProduct.
  const pubs = await prisma.productPublication.findMany({
    where: { catalogProduct: { is: { userId: user.id } } },
    select: {
      id: true,
      sku: true,
      externalProductId: true,
      externalSku: true,
      catalogProductId: true,
      catalogProduct: {
        select: {
          sku: true,
          supplierName: true,
          publicationSku: true,
          provider: { select: { name: true } },
        },
      },
    },
    orderBy: { id: "asc" },
  });

  // Clasificación en 4 buckets.
  type Bucket =
    | "MIGRATE"          // wooId + pubSku + pp.sku=null  → copy
    | "IDEMPOTENT_SKIP"  // pp.sku ya tiene valor → no tocar
    | "MANUAL_REQUIRED"  // wooId sin pubSku → log y no tocar
    | "LAZY_DEFERRED";   // sin wooId → no tocar (entra al lazy flow al publicar)

  const byBucket = new Map<Bucket, typeof pubs>();
  const buckets: Bucket[] = ["MIGRATE", "IDEMPOTENT_SKIP", "MANUAL_REQUIRED", "LAZY_DEFERRED"];
  for (const b of buckets) byBucket.set(b, []);

  for (const pub of pubs) {
    const cp = pub.catalogProduct;
    const hasWooId = !!pub.externalProductId;
    const hasPubSku = !!(cp.publicationSku && cp.publicationSku.trim());
    const ppSkuAlreadySet = !!(pub.sku && pub.sku.trim());

    let bucket: Bucket;
    if (ppSkuAlreadySet) bucket = "IDEMPOTENT_SKIP";
    else if (!hasWooId) bucket = "LAZY_DEFERRED";
    else if (hasPubSku) bucket = "MIGRATE";
    else bucket = "MANUAL_REQUIRED";

    byBucket.get(bucket)!.push(pub);
  }

  console.log("─── Clasificación ───");
  console.log(`  MIGRATE          (wooId + publicationSku → copy):    ${byBucket.get("MIGRATE")!.length}`);
  console.log(`  IDEMPOTENT_SKIP  (ProductPublication.sku ya seteado): ${byBucket.get("IDEMPOTENT_SKIP")!.length}`);
  console.log(`  MANUAL_REQUIRED  (wooId pero publicationSku=null):    ${byBucket.get("MANUAL_REQUIRED")!.length}`);
  console.log(`  LAZY_DEFERRED    (sin wooId, queda en null):          ${byBucket.get("LAZY_DEFERRED")!.length}`);
  console.log(`  TOTAL:                                                 ${pubs.length}`);

  // Muestra de MIGRATE (antes/después).
  console.log("\n─── Sample de MIGRATE (antes → después) ───");
  const migrateList = byBucket.get("MIGRATE")!;
  const sampleSize = Math.min(10, migrateList.length);
  for (const pub of migrateList.slice(0, sampleSize)) {
    const cp = pub.catalogProduct;
    console.log(
      `  pub=${pub.id.slice(-8)} woo=${pub.externalProductId} provider=${cp.provider.name.padEnd(12)} sku_raw='${cp.sku}'`
    );
    console.log(
      `    ProductPublication.sku: NULL → '${cp.publicationSku}'`
    );
  }
  if (migrateList.length > sampleSize) {
    console.log(`  ... (${migrateList.length - sampleSize} más)`);
  }

  // MANUAL_REQUIRED — listar TODOS (deberían ser 0 según el audit).
  const manualList = byBucket.get("MANUAL_REQUIRED")!;
  if (manualList.length > 0) {
    console.log(`\n─── MANUAL_REQUIRED (${manualList.length}) — requieren acción del usuario ───`);
    for (const pub of manualList) {
      const cp = pub.catalogProduct;
      console.log(
        `  pub=${pub.id} woo=${pub.externalProductId} extSku=${pub.externalSku} provider=${cp.provider.name} cp.sku='${cp.sku}' name="${cp.supplierName.slice(0, 50)}"`
      );
    }
  } else {
    console.log(`\n─── MANUAL_REQUIRED: 0 (limpio, como predijo el audit) ───`);
  }

  // Verificación específica de DURAVIT: tiene pub PAUSED sin wooId.
  // Debe caer en LAZY_DEFERRED, no en ningún otro bucket.
  const duravit = pubs.find((p) => p.id === "cmpkhqtz8005ldlttkxr1d1ks");
  if (duravit) {
    const cp = duravit.catalogProduct;
    const hasWooId = !!duravit.externalProductId;
    const hasPubSku = !!cp.publicationSku;
    const bucket = !duravit.sku && !hasWooId ? "LAZY_DEFERRED" : "OTHER";
    console.log(`\n─── Verificación DURAVIT (cp.sku='${cp.sku}') ───`);
    console.log(`  pub.id:               ${duravit.id}`);
    console.log(`  pub.sku:              ${duravit.sku === null ? "NULL" : `'${duravit.sku}'`}`);
    console.log(`  pub.externalProductId: ${duravit.externalProductId === null ? "NULL" : duravit.externalProductId}`);
    console.log(`  cp.publicationSku:    ${cp.publicationSku === null ? "NULL" : `'${cp.publicationSku}'`}`);
    console.log(
      `  → bucket: ${bucket}${bucket === "LAZY_DEFERRED" ? " ✓ (correcto: no migra, queda null)" : " ⚠"}`
    );
  }

  // Detectar colisiones en el target: dos publications distintas que terminarían
  // con el mismo pp.sku. (No debería haber, pero verificamos.)
  console.log("\n─── Verificación de colisiones post-migración ───");
  const counts = new Map<string, number>();
  for (const pub of migrateList) {
    const k = pub.catalogProduct.publicationSku!;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const collisions = [...counts.entries()].filter(([, n]) => n > 1);
  if (collisions.length === 0) {
    console.log(`  ✓ Sin colisiones: ${migrateList.length} valores distintos`);
  } else {
    console.log(`  ⚠ ${collisions.length} colisiones detectadas:`);
    for (const [sku, n] of collisions) {
      console.log(`    '${sku}' x${n}`);
    }
  }

  if (!APPLY) {
    console.log("\n→ Dry-run. Re-correr con --apply para escribir.");
    return;
  }

  // ════════════════════════════════════════════════════════════════════
  //                              APPLY
  // ════════════════════════════════════════════════════════════════════
  console.log("\n─── Aplicando MIGRATE en chunks ───");
  let migrated = 0;
  for (let i = 0; i < migrateList.length; i += CHUNK_SIZE) {
    const chunk = migrateList.slice(i, i + CHUNK_SIZE);
    await prisma.$transaction(
      chunk.map((pub) =>
        prisma.productPublication.update({
          where: { id: pub.id },
          data: { sku: pub.catalogProduct.publicationSku },
        })
      )
    );
    migrated += chunk.length;
    console.log(`  chunk ${i / CHUNK_SIZE + 1}: +${chunk.length} (acumulado ${migrated})`);
  }
  console.log(`\n✓ Migrados: ${migrated}/${migrateList.length}`);

  // Verificación post-apply.
  const verify = await prisma.$queryRawUnsafe<
    { total: bigint; con_sku: bigint; sin_sku: bigint }[]
  >(`
    SELECT COUNT(*) as total,
           COUNT(*) FILTER (WHERE sku IS NOT NULL) as con_sku,
           COUNT(*) FILTER (WHERE sku IS NULL) as sin_sku
    FROM "ProductPublication"
  `);
  const v = verify[0];
  console.log(`\n─── Verificación post-apply ───`);
  console.log(`  ProductPublication: total=${v.total}, con sku=${v.con_sku}, sin sku=${v.sin_sku}`);
}

main()
  .catch((e) => {
    console.error("ERROR:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
