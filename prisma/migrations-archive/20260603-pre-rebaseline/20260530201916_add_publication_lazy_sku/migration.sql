-- Fase 1 lazy SKU — solo agrega la columna estructural. No migra datos.
-- (Fase 2 hace el copy de CatalogProduct.publicationSku a este nuevo campo.)
ALTER TABLE "ProductPublication"
  ADD COLUMN "sku" TEXT;
