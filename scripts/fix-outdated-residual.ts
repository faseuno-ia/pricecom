// Script idempotente. Limpia flags residuales de drift en ProductPublication.
//
// Contexto: el deploy del drift detector (commits 5e5d63c / 9435280) marcó
// masivamente como OUTDATED muchas publications, pero la mayoría no tiene
// discrepancia real entre el precio efectivo calculado por el motor y el
// priceInStore guardado. Esos son "residuales": no requieren push a Woo.
//
// Criterio para limpiar:
//   syncStatus = 'OUTDATED' && pendingSync = true &&
//   |effectivePrice − priceInStore| ≤ 0.50
//
// Acción para los que cumplen: syncStatus → 'SYNCED', pendingSync → false.
// El resto (drift real) queda OUTDATED para que el usuario lo sincronice.
//
// Idempotente: en la segunda corrida no hay publications "limpiables" porque
// las residuales ya pasaron a SYNCED.

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const DRIFT_TOLERANCE = 0.5;

interface CatalogProductPricing {
  id: string;
  wholesalePrice: number | null;
  finalPrice: number | null;
  manualMargin: number | null;
  manualPrice: number | null;
  assignedCategoryId: string | null;
  providerId: string;
  userId: string;
}

interface PricingRuleLite {
  scope: "GLOBAL" | "CATEGORY" | "PROVIDER";
  scopeId: string | null;
  marginPercent: number;
  priority: number;
}

function resolveEffectivePrice(
  cp: CatalogProductPricing,
  rulesByUser: Map<string, PricingRuleLite[]>
): number | null {
  if (cp.finalPrice != null) return cp.finalPrice;
  if (cp.manualPrice != null) return cp.manualPrice;
  if (cp.wholesalePrice == null) return null;
  if (cp.manualMargin != null) {
    return (
      Math.round(cp.wholesalePrice * (1 + cp.manualMargin / 100) * 100) / 100
    );
  }
  const rules = rulesByUser.get(cp.userId) ?? [];
  const applicable =
    rules.find(
      (r) => r.scope === "CATEGORY" && r.scopeId === cp.assignedCategoryId
    ) ??
    rules.find((r) => r.scope === "PROVIDER" && r.scopeId === cp.providerId) ??
    rules.find((r) => r.scope === "GLOBAL");
  if (!applicable) return null;
  return (
    Math.round(cp.wholesalePrice * (1 + applicable.marginPercent / 100) * 100) /
    100
  );
}

async function main() {
  const flagged = await prisma.productPublication.findMany({
    where: { syncStatus: "OUTDATED", pendingSync: true },
    select: {
      id: true,
      priceInStore: true,
      catalogProduct: {
        select: {
          id: true,
          sku: true,
          publicationSku: true,
          wholesalePrice: true,
          finalPrice: true,
          manualMargin: true,
          manualPrice: true,
          assignedCategoryId: true,
          providerId: true,
          userId: true,
        },
      },
    },
  });

  console.log(`Publications con OUTDATED + pendingSync=true: ${flagged.length}`);
  if (flagged.length === 0) {
    console.log("Nada que limpiar — base ya está limpia.");
    return;
  }

  // Cargo pricing rules para cada userId presente.
  const userIds = Array.from(
    new Set(flagged.map((f) => f.catalogProduct.userId))
  );
  const rulesByUser = new Map<string, PricingRuleLite[]>();
  for (const uid of userIds) {
    const rules = await prisma.pricingRule.findMany({
      where: { userId: uid, isActive: true },
      orderBy: { priority: "desc" },
      select: {
        scope: true,
        scopeId: true,
        marginPercent: true,
        priority: true,
      },
    });
    rulesByUser.set(uid, rules);
  }

  const residualIds: string[] = [];
  let driftReal = 0;
  let cannotCompute = 0;

  for (const f of flagged) {
    const eff = resolveEffectivePrice(f.catalogProduct, rulesByUser);
    if (eff == null || f.priceInStore == null) {
      cannotCompute++;
      continue;
    }
    if (Math.abs(eff - f.priceInStore) <= DRIFT_TOLERANCE) {
      residualIds.push(f.id);
    } else {
      driftReal++;
    }
  }

  console.log(`Drift real (Δ > $${DRIFT_TOLERANCE}):     ${driftReal}`);
  console.log(`Residuales a limpiar:           ${residualIds.length}`);
  console.log(`Sin datos para comparar:        ${cannotCompute}`);

  if (residualIds.length === 0) {
    console.log("\nNo hay residuales para limpiar.");
    return;
  }

  // Cleanup en batches para no mandar un IN gigante a Postgres.
  const BATCH = 500;
  let cleaned = 0;
  for (let i = 0; i < residualIds.length; i += BATCH) {
    const slice = residualIds.slice(i, i + BATCH);
    const result = await prisma.productPublication.updateMany({
      where: { id: { in: slice } },
      data: { syncStatus: "SYNCED", pendingSync: false },
    });
    cleaned += result.count;
  }

  console.log(`\n✓ Publications residuales → SYNCED: ${cleaned}`);
  console.log(`· OUTDATED restantes (drift real):   ${driftReal}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
