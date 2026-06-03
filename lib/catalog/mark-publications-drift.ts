// Marca ProductPublication como desincronizadas con la tienda. Lo invocan
// los endpoints del catálogo que modifican campos visibles en WooCommerce
// (precio, título, descripción), las acciones masivas de bulk-update, y
// el handler post-extracción del worker (upsertCatalogProducts) cuando
// detecta que el wholesalePrice cambió.
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
//
// La función está separada en dos:
//   - findDriftingPublications: PURA, read-only. Devuelve qué publications
//     están en drift y por qué. Misma fuente de verdad que usa el wrapper.
//   - markPublicationsDrift: usa findDriftingPublications + escribe.
// Esto garantiza que un dry-run y un apply nunca puedan discrepar — la
// decisión de "qué considerar drift" vive en un solo lugar.

import type { PrismaClient } from "@prisma/client";
import {
  resolvePricing,
  type PricingRuleForCalc,
} from "@/lib/pricing/pricing-engine";
import { logInfo } from "@/lib/events/event-log";

const DRIFT_TOLERANCE = 0.5;

export type DriftReason =
  | "user-edited" // commercialTitle/Description editado, no hay forma de comparar contra Woo
  | "no-baseline" // priceInStore es null, no hay snapshot para comparar
  | "no-price-calculable" // resolvePricing devolvió null (wholesale null + sin finalPrice override)
  | "price-drift"; // diferencia real de precio > tolerancia

export interface DriftRow {
  publicationId: string;
  catalogProductId: string;
  wooPriceInStore: number | null;
  expectedPrice: number | null;
  reason: DriftReason;
}

/**
 * READ-ONLY. Detecta qué publications en `catalogProductIds` están en drift y
 * por qué. No escribe nada. Misma decisión que aplica markPublicationsDrift —
 * si esta función devuelve una pub, el wrapper la marca OUTDATED.
 *
 * Útil además del wrapper para dry-runs, reporting y auditorías sin mutar.
 */
export async function findDriftingPublications(
  prisma: PrismaClient,
  catalogProductIds: string[]
): Promise<DriftRow[]> {
  if (catalogProductIds.length === 0) return [];

  const publications = await prisma.productPublication.findMany({
    where: {
      catalogProductId: { in: catalogProductIds },
      status: "ACTIVE",
      syncStatus: { not: "PENDING_SYNC" },
    },
    select: {
      id: true,
      catalogProductId: true,
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

  if (publications.length === 0) return [];

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

  const drifts: DriftRow[] = [];

  for (const pub of publications) {
    // 1. User-edited fields → siempre drift (no hay forma de detectar drift
    //    real para título/descripción contra Woo).
    if (
      pub.commercialTitleUserEdited ||
      pub.commercialDescriptionUserEdited
    ) {
      drifts.push({
        publicationId: pub.id,
        catalogProductId: pub.catalogProductId,
        wooPriceInStore: pub.priceInStore,
        expectedPrice: null,
        reason: "user-edited",
      });
      continue;
    }

    // 2. Sin baseline en la tienda → drift (publication recién creada o sin
    //    último sync exitoso).
    if (pub.priceInStore == null) {
      drifts.push({
        publicationId: pub.id,
        catalogProductId: pub.catalogProductId,
        wooPriceInStore: null,
        expectedPrice: null,
        reason: "no-baseline",
      });
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
    // 4. No se pudo calcular → drift por precaución. La salvaguarda real
    //    vive en publishProductToWoo (aborta con error "Sin precio calculado"
    //    antes de tocar Woo). Acá lo marcamos para que sea visible al usuario
    //    en la cola de pendientes; cuando intente sincronizar, el sync mostrará
    //    el error claro.
    if (effective == null) {
      drifts.push({
        publicationId: pub.id,
        catalogProductId: pub.catalogProductId,
        wooPriceInStore: pub.priceInStore,
        expectedPrice: null,
        reason: "no-price-calculable",
      });
      continue;
    }
    // 5. Drift real superior a la tolerancia.
    if (Math.abs(effective - pub.priceInStore) > DRIFT_TOLERANCE) {
      drifts.push({
        publicationId: pub.id,
        catalogProductId: pub.catalogProductId,
        wooPriceInStore: pub.priceInStore,
        expectedPrice: effective,
        reason: "price-drift",
      });
    }
  }

  return drifts;
}

/**
 * Marca como OUTDATED las publications que `findDriftingPublications` detecta
 * como en drift. Wrapper que escribe.
 *
 * Devuelve el conteo de filas marcadas. Si nadie está en drift, no escribe ni
 * loguea.
 */
export async function markPublicationsDrift(
  prisma: PrismaClient,
  catalogProductIds: string[]
): Promise<number> {
  const drifts = await findDriftingPublications(prisma, catalogProductIds);
  if (drifts.length === 0) return 0;

  const driftIds = drifts.map((d) => d.publicationId);

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
