// Mock reusable de WooCommerceClient. Reemplaza temporalmente métodos del
// prototype con implementaciones provistas, y devuelve un restore() para
// volver al original al final del test.
//
// Patrón extraído de los rigs _temp de Fase 4B (guard 3 / TOCTOU): testear
// flujos que tocan Woo sin hacer requests reales contra la tienda.
//
// Uso:
//
//   import { applyWooMock } from "../helpers/woo-mock";
//
//   it("rechaza si el SKU ya existe en Woo", async () => {
//     const restore = applyWooMock({
//       findProductsBySku: async () => [{ id: 99, sku: "TEK-001" }],
//     });
//     try {
//       // ... test ...
//     } finally {
//       restore();
//     }
//   });
//
// Para soporte de múltiples overrides simultáneos en el mismo test, encadenar
// applyWooMock devuelve un restore que revierte solo los métodos que pisó (no
// rompe mocks previos).

import { WooCommerceClient } from "@/lib/integrations/woocommerce/client";

// Permite override de cualquier método async del cliente. Usamos `any` en la
// firma de los handlers para no encadenar genéricos por cada método; el test
// se encarga de devolver la forma correcta.
//
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyAsync = (...args: any[]) => Promise<any>;

export type WooMockOverrides = {
  [K in keyof WooCommerceClient as WooCommerceClient[K] extends AnyAsync
    ? K
    : never]?: AnyAsync;
};

export function applyWooMock(overrides: WooMockOverrides): () => void {
  const proto = WooCommerceClient.prototype as unknown as Record<
    string,
    AnyAsync
  >;
  const originals = new Map<string, AnyAsync>();

  for (const [method, impl] of Object.entries(overrides)) {
    if (typeof impl !== "function") continue;
    originals.set(method, proto[method]);
    proto[method] = impl;
  }

  return function restore() {
    for (const [method, original] of originals) {
      proto[method] = original;
    }
  };
}
