// Helper compartido entre /preview y /apply para construir el `where` de
// CatalogProduct según el alcance pedido.

import type { Prisma } from "@prisma/client";

export interface ApplyMarginInput {
  productIds?: string[];
  providerId?: string;
  categoryId?: string;
  applyAll?: boolean;
}

export function buildApplyMarginWhere(
  userId: string,
  input: ApplyMarginInput
): Prisma.CatalogProductWhereInput | null {
  // Excluimos ignored por default — operaciones masivas no deberían tocar
  // estados terminales sin un flag explícito. También excluimos productos
  // removidos por el proveedor **cuando dependen del proveedor**: los OWN o
  // HYBRID sobreviven a SUPPLIER_REMOVED y deberían seguir siendo elegibles.
  const base: Prisma.CatalogProductWhereInput = {
    userId,
    NOT: [
      { internalStatus: "IGNORED" },
      {
        AND: [
          { supplierStatus: "SUPPLIER_REMOVED" },
          { stockSource: "SUPPLIER" },
        ],
      },
    ],
  };

  if (input.productIds && input.productIds.length > 0) {
    return { ...base, id: { in: input.productIds } };
  }
  if (input.categoryId) {
    return { ...base, assignedCategoryId: input.categoryId };
  }
  if (input.providerId) {
    return { ...base, providerId: input.providerId };
  }
  if (input.applyAll) {
    return base;
  }
  return null;
}
