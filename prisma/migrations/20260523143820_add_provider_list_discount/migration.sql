-- AlterTable: Provider — descuento sobre lista (0-100%, aplicado por el
-- pricing engine antes del margen de venta).
ALTER TABLE "Provider"
  ADD COLUMN "listDiscountPercent" DECIMAL(5, 2) NOT NULL DEFAULT 0;
