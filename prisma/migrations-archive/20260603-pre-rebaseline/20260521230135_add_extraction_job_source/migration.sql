-- AlterTable: ExtractionJob — origen del job y referencia al import batch
ALTER TABLE "ExtractionJob"
  ADD COLUMN "source" TEXT,
  ADD COLUMN "importBatchId" TEXT;

CREATE INDEX "ExtractionJob_source_idx" ON "ExtractionJob"("source");
CREATE INDEX "ExtractionJob_importBatchId_idx" ON "ExtractionJob"("importBatchId");

-- AlterTable: ProductChange — referencia directa al batch para filtrar sin join
ALTER TABLE "ProductChange"
  ADD COLUMN "importBatchId" TEXT;

CREATE INDEX "ProductChange_importBatchId_idx" ON "ProductChange"("importBatchId");
