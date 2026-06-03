-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Provider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "baseUrl" TEXT NOT NULL,
    "requiresLogin" BOOLEAN NOT NULL DEFAULT false,
    "username" TEXT,
    "encryptedPassword" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "lastExtractionAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Provider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProviderScraperConfig" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "productCardSelector" TEXT,
    "skuSelector" TEXT,
    "nameSelector" TEXT,
    "descriptionSelector" TEXT,
    "priceSelector" TEXT,
    "oldPriceSelector" TEXT,
    "stockSelector" TEXT,
    "categorySelector" TEXT,
    "imageSelector" TEXT,
    "productUrlSelector" TEXT,
    "nextPageSelector" TEXT,
    "maxPages" INTEGER NOT NULL DEFAULT 10,
    "waitForSelector" TEXT,
    "loginUsernameSelector" TEXT,
    "loginPasswordSelector" TEXT,
    "loginSubmitSelector" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderScraperConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractionJob" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "status" "JobStatus" NOT NULL DEFAULT 'PENDING',
    "startUrl" TEXT,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "progress" INTEGER NOT NULL DEFAULT 0,
    "totalProducts" INTEGER NOT NULL DEFAULT 0,
    "productsWithPrice" INTEGER NOT NULL DEFAULT 0,
    "productsWithoutPrice" INTEGER NOT NULL DEFAULT 0,
    "productsWithoutSku" INTEGER NOT NULL DEFAULT 0,
    "excelFilePath" TEXT,
    "excelFileUrl" TEXT,
    "errorMessage" TEXT,
    "workerLockedAt" TIMESTAMP(3),
    "workerPid" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtractionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractedProduct" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "sku" TEXT,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "wholesalePrice" DECIMAL(10,2),
    "oldPrice" DECIMAL(10,2),
    "stock" TEXT,
    "category" TEXT,
    "brand" TEXT,
    "productUrl" TEXT,
    "imageUrl" TEXT,
    "status" TEXT,
    "observations" TEXT,
    "rawData" JSONB,
    "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtractedProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractionLog" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "level" "LogLevel" NOT NULL DEFAULT 'INFO',
    "message" TEXT NOT NULL,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtractionLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderScraperConfig_providerId_key" ON "ProviderScraperConfig"("providerId");

-- CreateIndex
CREATE INDEX "ExtractionJob_status_createdAt_idx" ON "ExtractionJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ExtractedProduct_jobId_idx" ON "ExtractedProduct"("jobId");

-- CreateIndex
CREATE INDEX "ExtractedProduct_providerId_idx" ON "ExtractedProduct"("providerId");

-- CreateIndex
CREATE INDEX "ExtractedProduct_sku_idx" ON "ExtractedProduct"("sku");

-- CreateIndex
CREATE INDEX "ExtractionLog_jobId_idx" ON "ExtractionLog"("jobId");

-- AddForeignKey
ALTER TABLE "ProviderScraperConfig" ADD CONSTRAINT "ProviderScraperConfig_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionJob" ADD CONSTRAINT "ExtractionJob_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedProduct" ADD CONSTRAINT "ExtractedProduct_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ExtractionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionLog" ADD CONSTRAINT "ExtractionLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ExtractionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
