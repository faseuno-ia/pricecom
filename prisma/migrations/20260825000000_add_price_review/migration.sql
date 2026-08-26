-- P2-A · PRICE REVIEW · expand-first. Tablas VACÍAS e INERTES.
--
-- Ningún código de aplicación lee ni escribe estas tablas en P2-A: la captura es P2-B y el apply
-- es posterior. El código viejo sigue operativo sin cambio de comportamiento.
--
-- Existen porque hoy REVIEW_REQUIRED retorna antes de la transacción que persiste todo, así que el
-- write-set se pierde con el proceso — verificado: el job bloqueado del 2026-08-25 tiene
-- ExtractedProduct = 0, y de sus 1065 candidatos sólo sobreviven 5 outliers en ExtractionLog.
--
-- PriceReviewItem.extractedProductId es ON DELETE RESTRICT A PROPÓSITO: es el PIN de evidencia.
-- Una propuesta pendiente no puede quedar apuntando a evidencia borrada, y borrar el job que la
-- sustenta debe fallar en voz alta. Con las tablas vacías la restricción es inalcanzable, así que
-- esta migración no altera ningún borrado existente.
--
-- PriceReview.extractionJobId es RESTRICT y NO cascade: la propuesta tiene ciclo de vida propio y
-- sobrevive a la falla del job (JOB_EXECUTION_SUCCESS ≠ PROPOSAL_INTEGRITY).
--
-- Sólo CREATE TYPE / CREATE TABLE / CREATE INDEX / ADD CONSTRAINT. Ningún UPDATE, DELETE, DROP ni
-- ALTER de columna existente. Sin backfill.

-- CreateEnum
CREATE TYPE "PriceReviewStatus" AS ENUM ('PENDING', 'APPROVED_NOT_APPLIED', 'APPLIED', 'REJECTED', 'EXPIRED', 'FAILED_APPLY');

-- CreateEnum
CREATE TYPE "PriceReviewItemStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'APPLIED', 'CONFLICTED');

-- CreateTable
CREATE TABLE "PriceReview" (
    "id" TEXT NOT NULL,
    "extractionJobId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "status" "PriceReviewStatus" NOT NULL DEFAULT 'PENDING',
    "proposalSha" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "shape" TEXT NOT NULL,
    "preflightMetrics" JSONB NOT NULL,
    "catalogTotalCount" INTEGER NOT NULL,
    "writeSetCount" INTEGER NOT NULL,
    "changedCount" INTEGER NOT NULL,
    "presentWithoutPriceCount" INTEGER NOT NULL,
    "verifiedAbsentCount" INTEGER NOT NULL,
    "unverifiedCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "appliedAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "appliedCount" INTEGER,
    "conflictedCount" INTEGER,
    "failureReason" TEXT,

    CONSTRAINT "PriceReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceReviewItem" (
    "id" TEXT NOT NULL,
    "priceReviewId" TEXT NOT NULL,
    "catalogProductId" TEXT NOT NULL,
    "extractedProductId" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "oldPrice" DOUBLE PRECISION,
    "proposedPrice" DOUBLE PRECISION NOT NULL,
    "canonicalUrl" TEXT,
    "status" "PriceReviewItemStatus" NOT NULL DEFAULT 'PENDING',
    "conflictReason" TEXT,

    CONSTRAINT "PriceReviewItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PriceReview_extractionJobId_key" ON "PriceReview"("extractionJobId");

-- CreateIndex
CREATE INDEX "PriceReview_providerId_status_idx" ON "PriceReview"("providerId", "status");

-- CreateIndex
CREATE INDEX "PriceReview_userId_status_idx" ON "PriceReview"("userId", "status");

-- CreateIndex
CREATE INDEX "PriceReviewItem_priceReviewId_status_idx" ON "PriceReviewItem"("priceReviewId", "status");

-- CreateIndex
CREATE INDEX "PriceReviewItem_extractedProductId_idx" ON "PriceReviewItem"("extractedProductId");

-- CreateIndex
CREATE UNIQUE INDEX "PriceReviewItem_priceReviewId_sku_key" ON "PriceReviewItem"("priceReviewId", "sku");

-- AddForeignKey
ALTER TABLE "PriceReview" ADD CONSTRAINT "PriceReview_extractionJobId_fkey" FOREIGN KEY ("extractionJobId") REFERENCES "ExtractionJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceReview" ADD CONSTRAINT "PriceReview_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceReview" ADD CONSTRAINT "PriceReview_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceReviewItem" ADD CONSTRAINT "PriceReviewItem_priceReviewId_fkey" FOREIGN KEY ("priceReviewId") REFERENCES "PriceReview"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceReviewItem" ADD CONSTRAINT "PriceReviewItem_catalogProductId_fkey" FOREIGN KEY ("catalogProductId") REFERENCES "CatalogProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceReviewItem" ADD CONSTRAINT "PriceReviewItem_extractedProductId_fkey" FOREIGN KEY ("extractedProductId") REFERENCES "ExtractedProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

