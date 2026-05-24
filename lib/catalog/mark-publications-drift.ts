// Marca ProductPublication como desincronizadas con la tienda. Lo invocan
// los endpoints del catálogo que modifican campos visibles en WooCommerce
// (precio, título, descripción) y las acciones masivas de bulk-update que
// cambian estado.
//
// Lógica inteligente: en vez de marcar todas las publications ACTIVE como
// OUTDATED a ciegas, compara el precio efectivo (mismo motor que usa
// publishProductToWoo) con priceInStore. Solo marca si hay drift real,
// evitando los residuales que llenaban la cola de "Desactualizados" sin
// motivo después de cada bulk-update masivo.
//
// Reglas:
//   - Solo evaluamos publications con status = ACTIVE y syncStatus != PENDING_SYNC
//     (las pausadas no necesitan reflejar el cambio; las ya encoladas no se
//     "rebajan" a OUTDATED).
//   - Marcamos siempre si commercialTitleUserEdited o commercialDescriptionUserEdited:
//     no hay snapshot remoto de esos campos para comparar, así que asumimos drift.
//   - Marcamos siempre si priceInStore es null (publication nueva, sin baseline).
//   - Marcamos defensivamente si resolvePricing no puede calcular (falso positivo
//     mejor que falso negativo: el push posterior con datos incompletos da error).
//   - Tolerancia de drift: $0.50 (alineado con scripts/fix-outdated-residual.ts).

import type { PrismaClient } from "@prisma/client";
import {
  resolvePricing,
  type PricingRuleForCalc,
} from "@/lib/pricing/pricing-engine";
import { logInfo } from "@/lib/events/event-log";

const DRIFT_TOLERANCE = 0.5;

export async function markPublicationsDrift(
  prisma: PrismaClient,
  catalogProductIds: string[]
): Promise<number> {
  if (catalogProductIds.length === 0) return 0;

  const publications = await prisma.productPublication.findMany({
    where: {
      catalogProductId: { in: catalogProductIds },
      status: "ACTIVE",
      syncStatus: { not: "PENDING_SYNC" },
    },
    select: {
      id: true,
      priceInStore: true,
      commercialTitleUserEdited: true,
      commercialDescriptionUserEdited: true,
      catalogProduct: {
        select: {
          wholesalePrice: true,
          finalPrice: true,
          manualMargin: true,
          assignedCategoryId: true,
          providerId: true,
          userId: true,
          provider: { select: { listDiscountPercent: true } },
        },
      },
    },
  });

  if (publications.length === 0) return 0;

  // Reglas de pricing por usuario — la cantidad de usuarios afectados suele
  // ser 1 (mismo usuario en el batch), pero cubrimos N por las dudas.
  const userIds = Array.from(
    new Set(publications.map((p) => p.catalogProduct.userId))
  );
  const rulesByUser = new Map<string, PricingRuleForCalc[]>();
  for (const uid of userIds) {
    const rules = await prisma.pricingRule.findMany({
      where: { userId: uid, isActive: true },
      orderBy: { priority: "desc" },
      select: {
        id: true,
        name: true,
        scope: true,
        scopeId: true,
        marginPercent: true,
        roundingMode: true,
        isActive: true,
        priority: true,
      },
    });
    rulesByUser.set(uid, rules);
  }

  const driftIds: string[] = [];
  for (const pub of publications) {
    // 1. User-edited fields → siempre drift (no hay forma de detectar drift
    //    real para título/descripción contra Woo).
    if (
      pub.commercialTitleUserEdited ||
      pub.commercialDescriptionUserEdited
    ) {
      driftIds.push(pub.id);
      continue;
    }

    // 2. Sin baseline en la tienda → drift (publication recién creada o sin
    //    último sync exitoso).
    if (pub.priceInStore == null) {
      driftIds.push(pub.id);
      continue;
    }

    // 3. Comparar precio efectivo vs priceInStore.
    const rules = rulesByUser.get(pub.catalogProduct.userId) ?? [];
    const pricing = resolvePricing(
      {
        wholesalePrice: pub.catalogProduct.wholesalePrice,
        manualMargin: pub.catalogProduct.manualMargin,
        finalPrice: pub.catalogProduct.finalPrice,
        assignedCategoryId: pub.catalogProduct.assignedCategoryId,
        providerId: pub.catalogProduct.providerId,
        listDiscountPercent: pub.catalogProduct.provider?.listDiscountPercent
          ? Number(pub.catalogProduct.provider.listDiscountPercent)
          : 0,
      },
      rules
    );
    const effective = pricing.effectivePrice;
    // 4. No se pudo calcular → drift por precaución.
    if (effective == null) {
      driftIds.push(pub.id);
      continue;
    }
    // 5. Drift real superior a la tolerancia.
    if (Math.abs(effective - pub.priceInStore) > DRIFT_TOLERANCE) {
      driftIds.push(pub.id);
    }
  }

  if (driftIds.length === 0) return 0;

  const res = await prisma.productPublication.updateMany({
    where: { id: { in: driftIds } },
    data: {
      pendingSync: true,
      syncStatus: "OUTDATED",
    },
  });

  await logInfo({
    source: "SYSTEM",
    type: "PRODUCT_MARKED_OUTDATED",
    title: `${res.count} publicación(es) marcadas como desactualizadas`,
    metadata: {
      count: res.count,
      publicationIds: driftIds,
      catalogProductIds,
    },
  });

  return res.count;
}
