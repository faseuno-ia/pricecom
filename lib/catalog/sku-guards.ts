// Guards de colisión de SKU comercial dentro del catálogo PricEcom.
// Usado por:
//   - PUT /api/catalog/publications/[id]/sku (4B edición manual)
//   - publishProductToWoo CREATE / UPDATE-con-drift (Fase 3 lazy)
//   - POST /api/catalog/manual (4F, alta de producto manual)
//   - POST /api/catalog/import (4F, import de Excel)
//
// El chequeo es DOBLE: ProductPublication.sku (canónico post-Fase 3) Y
// CatalogProduct.publicationSku (legacy hasta Fase 5). Mientras coexistan,
// ambos campos se miran para no perder casos.

import type { PrismaClient } from "@prisma/client";

export type PricEcomSkuCollision = {
  /** Quién tiene el SKU: una publication o un CatalogProduct (legacy). */
  source: "publication" | "catalogProduct";
  /** Id del registro en conflicto (pub.id o cp.id según source). */
  id: string;
  /** Id del CatalogProduct dueño del SKU en conflicto (en ambos casos). */
  catalogProductId: string;
  /** Nombre del producto en conflicto, para el mensaje al usuario. */
  supplierName: string;
};

/**
 * Devuelve el primer conflicto encontrado o null si el SKU está libre.
 *
 * @param prisma  Cliente Prisma.
 * @param userId  Scope del usuario (un mismo SKU puede coexistir entre
 *                usuarios distintos).
 * @param sku     SKU a verificar (ya trimmed).
 * @param exclude Excludes opcionales para "renombrar consigo mismo":
 *                - publicationId: id de la pub que estamos editando (no
 *                  contarla a sí misma como conflicto).
 *                - catalogProductId: id del CP cuyo publicationSku legacy
 *                  pertenece a este renombre (no contarlo como conflicto).
 */
export async function findCollidingSkuInPricEcom(
  prisma: PrismaClient,
  userId: string,
  sku: string,
  exclude?: { publicationId?: string; catalogProductId?: string }
): Promise<PricEcomSkuCollision | null> {
  const collisionPp = await prisma.productPublication.findFirst({
    where: {
      sku,
      catalogProduct: { is: { userId } },
      ...(exclude?.publicationId ? { id: { not: exclude.publicationId } } : {}),
    },
    select: {
      id: true,
      catalogProductId: true,
      catalogProduct: { select: { supplierName: true } },
    },
  });
  if (collisionPp) {
    return {
      source: "publication",
      id: collisionPp.id,
      catalogProductId: collisionPp.catalogProductId,
      supplierName: collisionPp.catalogProduct.supplierName,
    };
  }

  const collisionCp = await prisma.catalogProduct.findFirst({
    where: {
      publicationSku: sku,
      userId,
      ...(exclude?.catalogProductId ? { id: { not: exclude.catalogProductId } } : {}),
    },
    select: { id: true, supplierName: true },
  });
  if (collisionCp) {
    return {
      source: "catalogProduct",
      id: collisionCp.id,
      catalogProductId: collisionCp.id,
      supplierName: collisionCp.supplierName,
    };
  }

  return null;
}
