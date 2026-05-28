-- Persistir el Excel de extracción en DB (bytes) en lugar del filesystem.
-- El contenedor de Railway es efímero y los archivos se perdían en redeploy.
ALTER TABLE "ExtractionJob"
  ADD COLUMN "excelData" BYTEA,
  ADD COLUMN "excelName" TEXT;
