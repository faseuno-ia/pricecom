-- AlterTable: ProductPublication — override per-publication de título y descripción
-- con flag user-edited. Permite que el sync Woo→PricEcom respete las ediciones
-- locales del usuario, y que PricEcom→Woo solo mande los campos que el usuario
-- realmente quiso pisar.
ALTER TABLE "ProductPublication"
  ADD COLUMN "commercialTitle" TEXT,
  ADD COLUMN "commercialTitleUserEdited" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "commercialDescription" TEXT,
  ADD COLUMN "commercialDescriptionUserEdited" BOOLEAN NOT NULL DEFAULT false;
