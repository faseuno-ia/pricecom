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

/**
 * Pisa `WooCommerceClient.fromIntegration` (estático) para que devuelva una
 * instancia construida con valores dummy, evitando el call a `decrypt()` sobre
 * `consumerKeyEncrypted/Secret`. Útil cuando el código bajo test construye el
 * cliente vía `fromIntegration` (por ej. upsertCatalogProducts → handleReappeared
 * → publishProductToWoo, o el push de auto-pause).
 *
 * Devuelve un restore que vuelve al original. El cliente devuelto sigue
 * teniendo el prototype monkey-patched por applyWooMock, así que ambos
 * helpers se combinan: applyWooMock define el comportamiento, mockWooFromIntegration
 * asegura que se pueda construir.
 */
export function mockWooFromIntegration(): () => void {
  const original = WooCommerceClient.fromIntegration;
  WooCommerceClient.fromIntegration = function fromIntegrationStub() {
    return new WooCommerceClient(
      "https://shop.example.test",
      "dummy-key",
      "dummy-secret"
    );
  };
  return function restore() {
    WooCommerceClient.fromIntegration = original;
  };
}
