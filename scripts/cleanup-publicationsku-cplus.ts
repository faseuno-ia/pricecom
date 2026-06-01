// C+ cleanup (post-Fase 3): nullea CatalogProduct.publicationSku para todos
// los CPs sin presencia en Woo (sin ProductPublication con externalProductId).
//
// Por qué C+ y no C:
//   - Tu regla: solo conservan SKU comercial los productos que están o estuvieron
//     en Woo. NINGUNO de los 4156 estuvo en Woo → todos deben pasar a "—".
//   - C limpiaría solo los 26 desalineados (IMPOTEKNO 17 + GABY 9); C+ cierra
//     la coexistencia de raíz para los 4156.
//
// Pre-requisito (CUMPLIDO al correr este script):
//   - Fase 3 deployado y worker nuevo activo (sin eager generation).
//     Confirmado: worker arrancó 2026-06-01T01:45:17Z, posterior al commit
//     c365699 (2026-05-31T22:43Z).
//
// Dry-run por default. Aplicar con --apply.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

async function main() {
  console.log(
    APPLY
      ? "═══ MODO APPLY ═══\n"
      : "═══ DRY-RUN (sin escribir). Usar --apply para ejecutar. ═══\n"
  );

  const user = await prisma.user.findUnique({
    where: { email: "admin@pricecom.com" },
    select: { id: true },
  });
  if (!user) throw new Error("admin@pricecom.com no encontrado");

  // ────────────────────────────────────────────────────────────
  // 1. Conteo total + por proveedor
  // ────────────────────────────────────────────────────────────
  console.log("─── 1. Target: CPs con publicationSku != null Y sin Woo ───");

  const total = await prisma.$queryRawUnsafe<{ total: bigint }[]>(`
    SELECT COUNT(*) as total
    FROM "CatalogProduct" cp
    WHERE cp."userId" = '${user.id}'
      AND cp."publicationSku" IS NOT NULL
      AND cp."publicationSku" <> ''
      AND NOT EXISTS (
        SELECT 1 FROM "ProductPublication" pp
        WHERE pp."catalogProductId" = cp.id
          AND pp."externalProductId" IS NOT NULL
      )
  `);
  console.log(`  Total a nullear: ${total[0].total}`);

  const byProvider = await prisma.$queryRawUnsafe<
    { provider_name: string; provider_type: string; total: bigint }[]
  >(`
    SELECT p.name as provider_name, p."providerType" as provider_type, COUNT(*) as total
    FROM "CatalogProduct" cp
    JOIN "Provider" p ON p.id = cp."providerId"
    WHERE cp."userId" = '${user.id}'
      AND cp."publicationSku" IS NOT NULL
      AND cp."publicationSku" <> ''
      AND NOT EXISTS (
        SELECT 1 FROM "ProductPublication" pp
        WHERE pp."catalogProductId" = cp.id
          AND pp."externalProductId" IS NOT NULL
      )
    GROUP BY p.id, p.name, p."providerType"
    ORDER BY total DESC
  `);
  console.log("\n  Desglose por proveedor:");
  let suma = 0;
  for (const r of byProvider) {
    suma += Number(r.total);
    console.log(`    ${r.provider_name.padEnd(22)} (${r.provider_type.padEnd(10)}) ${r.total}`);
  }
  console.log(`    ${"TOTAL".padEnd(22)} ${" ".repeat(12)} ${suma}`);

  // ────────────────────────────────────────────────────────────
  // 2. Confirmar invariante: nada con wooId != null se toca
  // ────────────────────────────────────────────────────────────
  console.log("\n─── 2. Invariante: CPs publicados (con wooId) que NO se tocan ───");
  const publicados = await prisma.$queryRawUnsafe<
    { total: bigint }[]
  >(`
    SELECT COUNT(*) as total
    FROM "CatalogProduct" cp
    WHERE cp."userId" = '${user.id}'
      AND cp."publicationSku" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "ProductPublication" pp
        WHERE pp."catalogProductId" = cp.id
          AND pp."externalProductId" IS NOT NULL
      )
  `);
  console.log(`  CPs publicados con publicationSku poblado: ${publicados[0].total}`);
  console.log(`  → Estos NO se tocan. Su publicationSku queda intacto (y coincide con pp.sku migrado en Fase 2).`);

  // Sanity: confirmar que ningún CP publicado quedaría en el target
  const incongruentes = await prisma.$queryRawUnsafe<{ total: bigint }[]>(`
    SELECT COUNT(*) as total
    FROM "CatalogProduct" cp
    WHERE cp."userId" = '${user.id}'
      AND cp."publicationSku" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "ProductPublication" pp
        WHERE pp."catalogProductId" = cp.id
          AND pp."externalProductId" IS NOT NULL
      )
      AND EXISTS (
        SELECT 1 FROM "ProductPublication" pp
        WHERE pp."catalogProductId" = cp.id
          AND pp."externalProductId" IS NULL
      )
  `);
  console.log(`  Sanity (CPs con pub publicada Y otra sin wooId — caso raro): ${incongruentes[0].total}`);

  // ────────────────────────────────────────────────────────────
  // 3. DURAVIT: verificar que ya está en null y no entra al target
  // ────────────────────────────────────────────────────────────
  console.log("\n─── 3. DURAVIT (cp.id=cmp6gif1g) ───");
  const duravit = await prisma.catalogProduct.findUnique({
    where: { id: "cmp6gif1g0asx889lovt90phw" },
    select: { sku: true, publicationSku: true, internalStatus: true },
  });
  console.log(`  publicationSku actual: ${duravit?.publicationSku === null ? "NULL ✓" : `"${duravit?.publicationSku}"`}`);
  console.log(`  → Ya en NULL. No entra al target (target requiere publicationSku != null). Sin cambio.`);

  // ────────────────────────────────────────────────────────────
  // 4. Sample antes/después (no aplicado en dry-run)
  // ────────────────────────────────────────────────────────────
  console.log("\n─── 4. Sample de 5 a nullear (uno por proveedor cuando hay) ───");
  for (const p of byProvider) {
    const sample = await prisma.$queryRawUnsafe<
      { id: string; sku: string; publicationSku: string }[]
    >(`
      SELECT cp.id, cp.sku, cp."publicationSku"
      FROM "CatalogProduct" cp
      JOIN "Provider" prov ON prov.id = cp."providerId"
      WHERE cp."userId" = '${user.id}'
        AND prov.name = '${p.provider_name.replace(/'/g, "''")}'
        AND cp."publicationSku" IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM "ProductPublication" pp
          WHERE pp."catalogProductId" = cp.id
            AND pp."externalProductId" IS NOT NULL
        )
      ORDER BY cp.sku
      LIMIT 1
    `);
    for (const s of sample) {
      console.log(`  ${p.provider_name.padEnd(22)} sku='${s.sku}' publicationSku="${s.publicationSku}" → NULL`);
    }
  }

  if (!APPLY) {
    console.log("\n→ Dry-run. Re-correr con --apply para escribir.");
    return;
  }

  // ════════════════════════════════════════════════════════════
  // APPLY
  // ════════════════════════════════════════════════════════════
  console.log("\n─── Aplicando UPDATE masivo ───");
  const res = await prisma.$executeRawUnsafe(`
    UPDATE "CatalogProduct"
    SET "publicationSku" = NULL
    WHERE "userId" = '${user.id}'
      AND "publicationSku" IS NOT NULL
      AND "publicationSku" <> ''
      AND NOT EXISTS (
        SELECT 1 FROM "ProductPublication" pp
        WHERE pp."catalogProductId" = "CatalogProduct".id
          AND pp."externalProductId" IS NOT NULL
      )
  `);
  console.log(`  ✓ Filas afectadas: ${res}`);

  // Verificación post
  console.log("\n─── Verificación post-apply ───");
  const remainingTarget = await prisma.$queryRawUnsafe<{ total: bigint }[]>(`
    SELECT COUNT(*) as total
    FROM "CatalogProduct" cp
    WHERE cp."userId" = '${user.id}'
      AND cp."publicationSku" IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM "ProductPublication" pp
        WHERE pp."catalogProductId" = cp.id
          AND pp."externalProductId" IS NOT NULL
      )
  `);
  console.log(`  CPs en estado target restantes (esperado 0): ${remainingTarget[0].total}`);

  const publicadosOk = await prisma.$queryRawUnsafe<{ total: bigint }[]>(`
    SELECT COUNT(*) as total
    FROM "CatalogProduct" cp
    WHERE cp."userId" = '${user.id}'
      AND cp."publicationSku" IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM "ProductPublication" pp
        WHERE pp."catalogProductId" = cp.id
          AND pp."externalProductId" IS NOT NULL
      )
  `);
  console.log(`  CPs publicados con publicationSku intacto: ${publicadosOk[0].total}`);
}

main()
  .catch((e) => {
    console.error("ERROR:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
