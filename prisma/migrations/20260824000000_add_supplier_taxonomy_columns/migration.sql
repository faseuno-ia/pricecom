-- C2-MINI-A · Espejo de taxonomía del proveedor. Seis columnas, tres por modelo, forma IDÉNTICA.
--
-- ADDITIVE-ONLY / backward-compatible. Ninguna columna existente se modifica, renombra ni borra.
-- Sin índices ni constraints nuevos (el GIN sobre `path` es deuda declarada, D-8). SIN BACKFILL: el
-- DEFAULT produce exactamente el estado "no observado", que es el correcto para las filas previas.
--
-- Las columnas llegan INERTES: ningún código las lee ni las escribe todavía (expand-first). El
-- punto de no retorno NO es esta migración, sino la primera extracción de DT con el código nuevo.
--
-- TRES ESTADOS, discriminados por `supplierTaxonomyObservedAt` — no por preferencia: el cliente de
-- Prisma tipa las listas escalares como no-nullable, así que NULL y [] colapsan en `[]` y la ruta
-- sola no puede separar "no se observó" de "se observó sin categoría".
--   observedAt = NULL                          → no hubo observación utilizable
--   observedAt <> NULL · uncategorized = true  → observación válida, sin categoría material
--   observedAt <> NULL · uncategorized = false → breadcrumb observado, en `path`
--
-- `String[]?` NO existe en Prisma (P1012, "Optional lists are not supported"), de ahí el default.
-- Ver C2-MINI-DESIGN-A D-1/D-6 y su remediación R1.

-- AlterTable
ALTER TABLE "ExtractedProduct" ADD COLUMN     "supplierTaxonomyObservedAt" TIMESTAMP(3),
ADD COLUMN     "supplierTaxonomyPath" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "supplierTaxonomyUncategorized" BOOLEAN;
-- AlterTable
ALTER TABLE "CatalogProduct" ADD COLUMN     "supplierTaxonomyObservedAt" TIMESTAMP(3),
ADD COLUMN     "supplierTaxonomyPath" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "supplierTaxonomyUncategorized" BOOLEAN;
