// Helpers compartidos para gestionar la relación CatalogProduct ↔ Category.
// Mantienen la invariante: el row con isPrimary=true en CatalogProductCategory
// está sincronizado con CatalogProduct.assignedCategoryId (categoría primaria
// = la que ven los pricing rules y los filtros legacy).

import type { PrismaClient } from "@prisma/client";

/// Después de mutar la M2M, fija como assignedCategoryId la primaria que
/// quedó (o null si no hay ninguna). Si hay primaria pero el flag estaba
/// inconsistente, también la corrige.
export async function syncPrimaryCategory(
  prisma: PrismaClient,
  catalogProductId: string
): Promise<void> {
  const rows = await prisma.catalogProductCategory.findMany({
    where: { catalogProductId },
    select: { categoryId: true, isPrimary: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  let primaryId: string | null = null;
  const primaries = rows.filter((r) => r.isPrimary);

  if (primaries.length === 1) {
    primaryId = primaries[0].categoryId;
  } else if (primaries.length > 1) {
    // Más de una primaria: nos quedamos con la más vieja y desmarcamos el
    // resto. Es un estado roto que normalizamos defensivamente.
    primaryId = primaries[0].categoryId;
    await prisma.catalogProductCategory.updateMany({
      where: {
        catalogProductId,
        categoryId: { in: primaries.slice(1).map((p) => p.categoryId) },
      },
      data: { isPrimary: false },
    });
  } else if (rows.length > 0) {
    // No hay ninguna primaria pero hay categorías: promovemos la más vieja.
    primaryId = rows[0].categoryId;
    await prisma.catalogProductCategory.update({
      where: {
        catalogProductId_categoryId: {
          catalogProductId,
          categoryId: primaryId,
        },
      },
      data: { isPrimary: true },
    });
  }

  await prisma.catalogProduct.update({
    where: { id: catalogProductId },
    data: { assignedCategoryId: primaryId },
  });
}
