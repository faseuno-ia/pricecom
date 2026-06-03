-- Provider.skuPrefix: prefijo del SKU comercial. Validado en API:
-- /^[A-Z0-9-]{0,10}$/. Default "" para no romper providers existentes.
ALTER TABLE "Provider"
  ADD COLUMN "skuPrefix" TEXT NOT NULL DEFAULT '';
