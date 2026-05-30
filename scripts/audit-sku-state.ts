// FASE 0 — audit del estado actual de SKUs comerciales. SOLO LECTURA.
//
// Objetivo: identificar cuántas ProductPublications podemos migrar limpias
// desde CatalogProduct.publicationSku → ProductPublication.sku (lazy SKU),
// cuántas requieren asignación manual, y detectar desalineaciones entre el
// prefijo histórico (imageFilenamePrefix) y el nuevo Provider.skuPrefix.
//
// NO escribe nada. Imprime tabla resumen y subreportes.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: "admin@pricecom.com" },
    select: { id: true },
  });
  if (!user) throw new Error("admin@pricecom.com no encontrado");

  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  AUDIT DE SKU COMERCIAL — FASE 0 (solo lectura)");
  console.log("═══════════════════════════════════════════════════════════════\n");

  // ───────────────────────────────────────────────────────────────
  // 1. Total ProductPublication
  // ───────────────────────────────────────────────────────────────
  const totalPubs = await prisma.productPublication.count({
    where: { catalogProduct: { is: { userId: user.id } } },
  });
  console.log(`1. Total ProductPublication: ${totalPubs}\n`);

  // ───────────────────────────────────────────────────────────────
  // 2. ProductPublication.sku != null — el campo aún no existe.
  // ───────────────────────────────────────────────────────────────
  console.log(
    `2. ProductPublication.sku != null: campo aún no existe en el schema (fase 1 lo agrega).\n`
  );

  // ───────────────────────────────────────────────────────────────
  // 3. Breakdown 2×2: externalProductId (wooId) × CatalogProduct.publicationSku
  // ───────────────────────────────────────────────────────────────
  const rows = await prisma.$queryRawUnsafe<
    {
      wooid_set: boolean;
      pubsku_set: boolean;
      total: bigint;
    }[]
  >(`
    SELECT
      (pp."externalProductId" IS NOT NULL) as wooid_set,
      (cp."publicationSku" IS NOT NULL AND cp."publicationSku" <> '') as pubsku_set,
      COUNT(*) as total
    FROM "ProductPublication" pp
    JOIN "CatalogProduct" cp ON cp.id = pp."catalogProductId"
    WHERE cp."userId" = '${user.id}'
    GROUP BY wooid_set, pubsku_set
    ORDER BY wooid_set DESC, pubsku_set DESC
  `);

  const buckets: Record<string, number> = {
    A_woo_yes_sku_yes: 0,
    B_woo_yes_sku_no: 0,
    C_woo_no_sku_yes: 0,
    D_woo_no_sku_no: 0,
  };
  for (const r of rows) {
    const key = r.wooid_set
      ? r.pubsku_set
        ? "A_woo_yes_sku_yes"
        : "B_woo_yes_sku_no"
      : r.pubsku_set
        ? "C_woo_no_sku_yes"
        : "D_woo_no_sku_no";
    buckets[key] = Number(r.total);
  }

  console.log("3. Combinación externalProductId × publicationSku:");
  console.log(
    `   A · wooId != null  +  publicationSku != null  →  migrables limpios:      ${buckets.A_woo_yes_sku_yes}`
  );
  console.log(
    `   B · wooId != null  +  publicationSku == null  →  PROBLEMA (publicado sin SKU): ${buckets.B_woo_yes_sku_no}`
  );
  console.log(
    `   C · wooId == null  +  publicationSku != null  →  con SKU pero nunca publicado: ${buckets.C_woo_no_sku_yes}`
  );
  console.log(
    `   D · wooId == null  +  publicationSku == null  →  flujo lazy aplica:      ${buckets.D_woo_no_sku_no}`
  );
  const sumBuckets =
    buckets.A_woo_yes_sku_yes +
    buckets.B_woo_yes_sku_no +
    buckets.C_woo_no_sku_yes +
    buckets.D_woo_no_sku_no;
  console.log(`   TOTAL:                                                              ${sumBuckets}\n`);

  if (buckets.B_woo_yes_sku_no > 0) {
    console.log(`   ⚠  Caso B (${buckets.B_woo_yes_sku_no}) requiere atención: hay publicaciones`);
    console.log(`      en Woo cuyo CatalogProduct no tiene publicationSku. Listado:`);
    const offenders = await prisma.$queryRawUnsafe<
      {
        id: string;
        externalProductId: string;
        externalSku: string | null;
        cp_sku: string | null;
        cp_publicationSku: string | null;
        provider_name: string;
      }[]
    >(`
      SELECT pp.id, pp."externalProductId", pp."externalSku",
             cp.sku as cp_sku, cp."publicationSku" as "cp_publicationSku",
             p.name as provider_name
      FROM "ProductPublication" pp
      JOIN "CatalogProduct" cp ON cp.id = pp."catalogProductId"
      JOIN "Provider" p ON p.id = cp."providerId"
      WHERE cp."userId" = '${user.id}'
        AND pp."externalProductId" IS NOT NULL
        AND (cp."publicationSku" IS NULL OR cp."publicationSku" = '')
      ORDER BY p.name, cp.sku
      LIMIT 30
    `);
    for (const o of offenders) {
      console.log(
        `        ${o.provider_name.padEnd(20)} pub=${o.id} woo=${o.externalProductId} extSku=${o.externalSku ?? "—"} cp.sku=${o.cp_sku ?? "—"}`
      );
    }
    if (buckets.B_woo_yes_sku_no > 30) {
      console.log(`        ... (${buckets.B_woo_yes_sku_no - 30} más)`);
    }
    console.log("");
  }

  // ───────────────────────────────────────────────────────────────
  // 4. CatalogProducts SIN ProductPublication, por proveedor
  // ───────────────────────────────────────────────────────────────
  const orphanCps = await prisma.$queryRawUnsafe<
    { provider_name: string; provider_type: string; total: bigint }[]
  >(`
    SELECT p.name as provider_name, p."providerType" as provider_type, COUNT(*) as total
    FROM "CatalogProduct" cp
    JOIN "Provider" p ON p.id = cp."providerId"
    LEFT JOIN "ProductPublication" pp ON pp."catalogProductId" = cp.id
    WHERE cp."userId" = '${user.id}' AND pp.id IS NULL
    GROUP BY p.id, p.name, p."providerType"
    ORDER BY total DESC
  `);
  let totalOrphanCps = 0;
  console.log("4. CatalogProducts SIN ProductPublication (por proveedor):");
  for (const o of orphanCps) {
    totalOrphanCps += Number(o.total);
    console.log(`   ${o.provider_name.padEnd(22)} (${o.provider_type.padEnd(10)}) ${o.total}`);
  }
  console.log(`   TOTAL: ${totalOrphanCps}\n`);

  // ───────────────────────────────────────────────────────────────
  // 5. Por proveedor: publicationSku que NO empiezan con skuPrefix configurado
  //    (skuPrefix vacío significa "cualquier publicationSku matchea")
  // ───────────────────────────────────────────────────────────────
  const providers = await prisma.provider.findMany({
    where: { userId: user.id },
    select: { id: true, name: true, skuPrefix: true, providerType: true },
    orderBy: { name: "asc" },
  });
  console.log("5. Desalineación prefijo: publicationSku que NO empiezan con Provider.skuPrefix");
  for (const p of providers) {
    const prefix = p.skuPrefix ?? "";
    if (prefix === "") {
      const total = await prisma.catalogProduct.count({
        where: {
          userId: user.id,
          providerId: p.id,
          publicationSku: { not: null },
        },
      });
      console.log(
        `   ${p.name.padEnd(22)} skuPrefix="" (sin config) — publicationSku no nulos: ${total}`
      );
      continue;
    }
    const aligned = await prisma.catalogProduct.count({
      where: {
        userId: user.id,
        providerId: p.id,
        publicationSku: { startsWith: prefix },
      },
    });
    const totalWithPubSku = await prisma.catalogProduct.count({
      where: {
        userId: user.id,
        providerId: p.id,
        publicationSku: { not: null },
      },
    });
    const misaligned = totalWithPubSku - aligned;
    const badge = misaligned > 0 ? "⚠ " : "✓ ";
    console.log(
      `   ${badge}${p.name.padEnd(22)} skuPrefix="${prefix}" — alineados: ${aligned}, desalineados: ${misaligned} de ${totalWithPubSku}`
    );

    // Sample de desalineados (max 5 por proveedor). Usamos raw SQL porque
    // Prisma no permite expresar "no null Y no startsWith" en un solo `not`.
    if (misaligned > 0) {
      const samples = await prisma.$queryRawUnsafe<
        { sku: string | null; publicationSku: string }[]
      >(`
        SELECT sku, "publicationSku"
        FROM "CatalogProduct"
        WHERE "userId" = '${user.id}'
          AND "providerId" = '${p.id}'
          AND "publicationSku" IS NOT NULL
          AND "publicationSku" NOT LIKE '${prefix.replace(/'/g, "''")}%'
        ORDER BY sku ASC
        LIMIT 5
      `);
      for (const s of samples) {
        console.log(
          `        sku=${(s.sku ?? "—").padEnd(20)} publicationSku=${s.publicationSku}`
        );
      }
    }
  }
  console.log("");

  // ───────────────────────────────────────────────────────────────
  // 6. Colisiones: publicationSku idéntico en CatalogProducts distintos
  // ───────────────────────────────────────────────────────────────
  const collisions = await prisma.$queryRawUnsafe<
    { publicationSku: string; total: bigint }[]
  >(`
    SELECT "publicationSku", COUNT(*) as total
    FROM "CatalogProduct"
    WHERE "userId" = '${user.id}'
      AND "publicationSku" IS NOT NULL
      AND "publicationSku" <> ''
    GROUP BY "publicationSku"
    HAVING COUNT(*) > 1
    ORDER BY total DESC
    LIMIT 30
  `);
  console.log(`6. Colisiones de publicationSku (mismo valor en CatalogProducts distintos):`);
  if (collisions.length === 0) {
    console.log("   ✓ Sin colisiones.\n");
  } else {
    const totalColl = collisions.reduce((a, c) => a + Number(c.total), 0);
    console.log(`   ⚠ ${collisions.length} valores duplicados, afectan ${totalColl} CatalogProducts.\n`);
    for (const c of collisions) {
      const items = await prisma.catalogProduct.findMany({
        where: { userId: user.id, publicationSku: c.publicationSku },
        select: {
          id: true,
          sku: true,
          supplierName: true,
          provider: { select: { name: true } },
          publications: { select: { externalProductId: true } },
        },
      });
      console.log(`   publicationSku="${c.publicationSku}" (x${c.total}):`);
      for (const it of items) {
        const woo = it.publications.map((p) => p.externalProductId).filter(Boolean).join(",");
        console.log(
          `     · ${it.provider.name.padEnd(20)} cp=${it.id} sku=${it.sku ?? "—"} woo=[${woo || "—"}] "${it.supplierName.slice(0, 40)}"`
        );
      }
    }
    console.log("");
  }

  // ───────────────────────────────────────────────────────────────
  // Cierre
  // ───────────────────────────────────────────────────────────────
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  Audit completado. Sin cambios en DB.");
  console.log("═══════════════════════════════════════════════════════════════");
}

main()
  .catch((e) => {
    console.error("ERROR:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
