// Helper centralizado para la lógica "qué cuenta como unmatched listable" en
// la pestaña No vinculados.
//
// Consumidores (mantener actualizado si se agregan más):
//   - app/api/my-store/unmatched/route.ts        → listado de la pestaña.
//   - app/(app)/my-store/page.tsx (RSC)           → contador del dashboard de
//                                                  Mi Tienda + initial badge.
//   - app/(app)/dashboard/page.tsx (RSC)          → tarjeta "Atención requerida"
//                                                  + bloque "Estado ecommerce"
//                                                  del dashboard principal.
//
// Origen: bug en producción donde la pestaña mostraba 63 productos "sin
// vincular" aunque ya tenían ProductPublication apuntando al wooId correcto.
// El fix de la query del LISTADO (Fix 2 en commit 65a43fe) corrigió el
// endpoint `/api/my-store/unmatched`, pero el CONTADOR del dashboard
// (`app/(app)/my-store/page.tsx`) tenía su propia copia de la query —
// quedó desincronizado y seguía contando crudo por resolved=false.
//
// Concentramos la lógica acá para que todos los consumidores apliquen el
// mismo filtro. Si en el futuro hay que ajustarlo, hay UN solo lugar.
// Cualquier sitio nuevo que muestre/cuente unmatched al usuario DEBE usar
// estos helpers, NO duplicar la query.

import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Construye el `where` de Prisma para unmatched listables: filas de
 * UnmatchedStoreProduct cuyo `externalProductId` NO está siendo usado por
 * una ProductPublication en la misma store. Esa es la lógica que define
 * "no vinculado" desde el punto de vista del usuario: si ya hay una pub que
 * conecta el producto Woo con un CatalogProduct, no está "sin vincular"
 * aunque el flag `resolved` siga en false.
 *
 * Pre-fetch interno de externalProductIds de las pubs en la store. Una
 * query extra por uso. Aceptable: la pestaña/dashboard no son hot path.
 */
async function buildUnmatchedListableWhere(
  prisma: PrismaClient,
  storeId: string,
  resolved: boolean
): Promise<Prisma.UnmatchedStoreProductWhereInput> {
  const pubs = await prisma.productPublication.findMany({
    where: { storeId, externalProductId: { not: null } },
    select: { externalProductId: true },
  });
  const externalIdsWithPublication = pubs
    .map((p) => p.externalProductId)
    .filter((x): x is string => !!x);

  return {
    storeId,
    resolved,
    ...(externalIdsWithPublication.length > 0
      ? { NOT: { externalProductId: { in: externalIdsWithPublication } } }
      : {}),
  };
}

/**
 * Where para "no vinculados activos" — la lista default de la pestaña y el
 * contador del dashboard. Unmatched con resolved=false que NO tienen pp
 * asociada con su externalProductId.
 */
export function buildActiveUnmatchedWhere(
  prisma: PrismaClient,
  storeId: string
): Promise<Prisma.UnmatchedStoreProductWhereInput> {
  return buildUnmatchedListableWhere(prisma, storeId, false);
}

/**
 * Where para "descartes manuales" — modo includeDiscarded del listado.
 * Unmatched con resolved=true que NO tienen pp asociada. Los que SÍ tienen
 * pp son link/create-catalog (resoluciones automáticas), no descartes
 * manuales del usuario.
 */
export function buildDiscardedUnmatchedWhere(
  prisma: PrismaClient,
  storeId: string
): Promise<Prisma.UnmatchedStoreProductWhereInput> {
  return buildUnmatchedListableWhere(prisma, storeId, true);
}
