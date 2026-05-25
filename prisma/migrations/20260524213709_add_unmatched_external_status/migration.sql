-- UnmatchedStoreProduct — guardar el estado del producto en la tienda
-- externa para que el flujo de "vincular" derive el ProductPublication.status
-- correcto (ACTIVE si era "publish", DRAFT si no).
ALTER TABLE "UnmatchedStoreProduct"
  ADD COLUMN "externalStatus" TEXT;
