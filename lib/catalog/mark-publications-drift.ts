// Marca ProductPublication como desincronizadas con la tienda. Lo invocan
// los endpoints del catálogo que modifican campos visibles en WooCommerce
// (precio, título, descripción, SKU comercial, categorías) y las acciones
// masivas de bulk-update que cambian estado.
//
// Reglas:
//   - Solo tocamos publications con `status = ACTIVE` (las pausadas no
//     necesitan reflejar el cambio en la tienda hasta que se publiquen).
//   - Respetamos `PENDING_SYNC`: ya hay algo encolado, OUTDATED no debería
//     "rebajar" la urgencia. ERROR sí lo pisamos — el siguiente push reintenta
//     y tiene datos frescos.

import type { PrismaClient } from "@prisma/client";

export async function markPublicationsDrift(
  prisma: PrismaClient,
  catalogProductIds: string[]
): Promise<number> {
  if (catalogProductIds.length === 0) return 0;
  const res = await prisma.productPublication.updateMany({
    where: {
      catalogProductId: { in: catalogProductIds },
      status: "ACTIVE",
      syncStatus: { not: "PENDING_SYNC" },
    },
    data: {
      pendingSync: true,
      syncStatus: "OUTDATED",
    },
  });
  return res.count;
}
