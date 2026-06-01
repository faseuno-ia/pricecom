// Guard compartido para detectar colisión de SKU contra WooCommerce ANTES de
// pushear (Fase 4B guard 3). Usado por:
//   - PUT /api/catalog/publications/[id]/sku (edición manual)
//   - publishProductToWoo CREATE (primera publicación lazy)
//   - publishProductToWoo UPDATE con drift de sku (retry desde pendingSync)
//
// Llamado siempre ANTES de intentar el push. Si devuelve { ok: false }, no
// tocar DB ni Woo, devolver error claro al caller.

import type { WooCommerceClient, WooProduct } from "./client";

export type WooSkuConflict = {
  ok: false;
  conflict: {
    id: number;
    sku: string;
    name: string;
    status: string;
    permalink: string;
  };
};

/**
 * Verifica que el SKU no esté siendo usado por OTRO producto en WooCommerce.
 *
 * @param client                Cliente Woo configurado (con fallback de auth).
 * @param sku                   SKU canónico a verificar.
 * @param excludeWooProductId   ID Woo del producto que estamos editando/creando.
 *                              Pasar null cuando es CREATE (no hay id propio
 *                              que excluir). Pasar el id Woo cuando es UPDATE
 *                              o renombre (no contamos al producto consigo
 *                              mismo como "conflicto").
 */
export async function assertSkuNotInWoo(
  client: WooCommerceClient,
  sku: string,
  excludeWooProductId: number | null
): Promise<{ ok: true } | WooSkuConflict> {
  const products: WooProduct[] = await client.findProductsBySku(sku);
  for (const p of products) {
    if (excludeWooProductId !== null && p.id === excludeWooProductId) continue;
    return {
      ok: false,
      conflict: {
        id: p.id,
        sku: p.sku,
        name: p.name,
        status: p.status,
        permalink: p.permalink,
      },
    };
  }
  return { ok: true };
}
