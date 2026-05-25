-- Add CatalogProduct.pausedBySystem: marca si la pausa actual fue automática
-- (sistema detectó SUPPLIER_REMOVED) o manual (acción del usuario).
ALTER TABLE "CatalogProduct"
  ADD COLUMN "pausedBySystem" BOOLEAN NOT NULL DEFAULT false;
