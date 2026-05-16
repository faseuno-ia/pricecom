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
  // Excluimos archived/ignored por default — operaciones masivas no deberían
  // tocar estados terminales sin un flag explícito.
  const base: Prisma.CatalogProductWhereInput = {
    userId,
    internalStatus: { notIn: ["ARCHIVED", "IGNORED"] },
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
