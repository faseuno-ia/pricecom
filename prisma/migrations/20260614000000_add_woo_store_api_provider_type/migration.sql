-- Frente: extractor WooCommerce Store API — agregar valor WOO_STORE_API al enum ProviderType.
-- Migración hand-written (NO generada con `prisma migrate dev`). Único cambio: ALTER TYPE ADD VALUE.
-- Cero filas afectadas.
--
-- Caveats (Postgres):
--   1. ADD VALUE es forward-only: Postgres no permite DROP de un valor de enum sin recrear el tipo
--      entero. No hay rollback limpio.
--   2. NO usar el valor WOO_STORE_API recién agregado dentro de la MISMA transacción que lo agrega
--      (Postgres lo rechaza). Cualquier INSERT/UPDATE de un Provider con providerType='WOO_STORE_API'
--      debe ir en una operación POSTERIOR y separada (la config de proveedores se carga después de que
--      esta migración esté aplicada).
--   3. ADD VALUE appendea el valor al final del orden físico del enum en Postgres, sin importar su
--      posición en schema.prisma. Es cosmético: los consumidores deben comparar por NOMBRE, no por orden.

ALTER TYPE "ProviderType" ADD VALUE 'WOO_STORE_API';
