// C2-MINI-A · R-4 · presentación de la taxonomía del proveedor. MÓDULO PURO.
//
// Vive separado del writer a propósito: `supplier-taxonomy-observation.ts` importa `@prisma/client`
// y `event-log`, y la UI (catalog-table, catalog-product-drawer) consume este render. Mientras
// ambas cosas convivieran en un archivo, un componente cliente arrastraba el cliente de Prisma.
//
// PROHIBIDO importar acá: Prisma · EventLog · DB · worker · cualquier dependencia server-only.
// Este archivo no tiene imports, y ésa es la propiedad que un test estructural vigila.

/** Los tres estados, tal como se muestran. Una sola definición para UI y para ambos Excel. */
export interface SupplierTaxonomyView {
  supplierTaxonomyPath?: string[] | null;
  supplierTaxonomyObservedAt?: Date | string | null;
  supplierTaxonomyUncategorized?: boolean | null;
}

/**
 * Render canónico del breadcrumb del proveedor.
 *
 * `notObserved` es parámetro porque Excel y UI difieren SÓLO en ese estado: la planilla usa celda
 * vacía y la pantalla un guion. Lo que NO puede diferir es colapsar "no observado" con "sin
 * categoría": son estados distintos y el diseño se tomó el trabajo de preservarlos.
 *
 *   observedAt = null                          → notObserved   ("" en Excel, "—" en UI)
 *   observedAt ≠ null · uncategorized = true   → "Sin categoría"
 *   observedAt ≠ null · path = [A,B,C]         → "A > B > C"
 */
export function renderSupplierTaxonomy(v: SupplierTaxonomyView, notObserved = ""): string {
  if (v.supplierTaxonomyObservedAt === null || v.supplierTaxonomyObservedAt === undefined) {
    return notObserved;
  }
  if (v.supplierTaxonomyUncategorized === true) return "Sin categoría";
  return (v.supplierTaxonomyPath ?? []).join(" > ");
}
