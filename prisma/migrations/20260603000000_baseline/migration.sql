-- CreateEnum
CREATE TYPE "ProviderType" AS ENUM ('SCRAPER', 'MANUAL', 'IMPORTED', 'OWN_STOCK');

-- CreateEnum
CREATE TYPE "JobStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ProductChangeType" AS ENUM ('NEW', 'REMOVED', 'PRICE_UP', 'PRICE_DOWN', 'STOCK_CHANGED');

-- CreateEnum
CREATE TYPE "ChangeReviewStatus" AS ENUM ('PENDING', 'REVIEWED', 'IGNORED');

-- CreateEnum
CREATE TYPE "LogLevel" AS ENUM ('DEBUG', 'INFO', 'WARN', 'ERROR');

-- CreateEnum
CREATE TYPE "StorePlatform" AS ENUM ('WOOCOMMERCE', 'SHOPIFY', 'TIENDANUBE');

-- CreateEnum
CREATE TYPE "PublicationSyncStatus" AS ENUM ('READY', 'PENDING_SYNC', 'SYNCED', 'OUTDATED', 'ERROR', 'PAUSED', 'ERROR_SKU_CONFLICT');

-- CreateEnum
CREATE TYPE "CatalogProductStatus" AS ENUM ('ACTIVE', 'SUPPLIER_REMOVED');

-- CreateEnum
CREATE TYPE "PublicationStatus" AS ENUM ('DRAFT', 'ACTIVE', 'PAUSED', 'REMOVED', 'ERROR');

-- CreateEnum
CREATE TYPE "ImageSource" AS ENUM ('SUPPLIER', 'USER', 'GENERATED');

-- CreateEnum
CREATE TYPE "CatalogSourceType" AS ENUM ('SCRAPED', 'MANUAL', 'IMPORTED');

-- CreateEnum
CREATE TYPE "StockSource" AS ENUM ('SUPPLIER', 'OWN', 'HYBRID');

-- CreateEnum
CREATE TYPE "InternalPublicationStatus" AS ENUM ('NOT_PUBLISHED', 'PREPARED', 'PUBLISHED', 'PAUSED', 'IGNORED');

-- CreateEnum
CREATE TYPE "PricingRuleScope" AS ENUM ('GLOBAL', 'PROVIDER', 'CATEGORY');

-- CreateEnum
CREATE TYPE "RoundingMode" AS ENUM ('NONE', 'CEIL', 'NEAREST_100', 'NEAREST_500', 'ENDING_990');

-- CreateEnum
CREATE TYPE "EventSeverity" AS ENUM ('INFO', 'WARNING', 'ERROR', 'CRITICAL');

-- CreateEnum
CREATE TYPE "EventSource" AS ENUM ('USER', 'WORKER', 'SYSTEM', 'SYNC', 'IMPORT', 'EXTRACTION', 'WOOCOMMERCE');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "name" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Provider" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "providerType" "ProviderType" NOT NULL DEFAULT 'SCRAPER',
    "baseUrl" TEXT NOT NULL,
    "requiresLogin" BOOLEAN NOT NULL DEFAULT false,
    "username" TEXT,
    "encryptedPassword" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT,
    "listDiscountPercent" DECIMAL(5,2) NOT NULL DEFAULT 0,
    "skuPrefix" TEXT NOT NULL DEFAULT '',
    "lastExtractionAt" TIMESTAMP(3),
    "userId" TEXT,
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
    "imageFilenamePrefix" TEXT,
    "categoryParamSelector" TEXT,
    "categoryParamName" TEXT,
    "catalogUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProviderScraperConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractionJob" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT,
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
    "excelData" BYTEA,
    "excelName" TEXT,
    "errorMessage" TEXT,
    "workerLockedAt" TIMESTAMP(3),
    "workerPid" INTEGER,
    "source" TEXT,
    "importBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExtractionJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExtractionComparison" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "previousJobId" TEXT,
    "newProducts" INTEGER NOT NULL DEFAULT 0,
    "removedProducts" INTEGER NOT NULL DEFAULT 0,
    "priceUp" INTEGER NOT NULL DEFAULT 0,
    "priceDown" INTEGER NOT NULL DEFAULT 0,
    "stockChanged" INTEGER NOT NULL DEFAULT 0,
    "unchanged" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExtractionComparison_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductChange" (
    "id" TEXT NOT NULL,
    "comparisonId" TEXT NOT NULL,
    "sku" TEXT,
    "productUrl" TEXT,
    "nameHash" TEXT,
    "name" TEXT NOT NULL,
    "changeType" "ProductChangeType" NOT NULL,
    "previousPrice" DOUBLE PRECISION,
    "currentPrice" DOUBLE PRECISION,
    "priceChangePercent" DOUBLE PRECISION,
    "previousStock" TEXT,
    "currentStock" TEXT,
    "reviewStatus" "ChangeReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedAt" TIMESTAMP(3),
    "importBatchId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductChange_pkey" PRIMARY KEY ("id")
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
    "imageFileName" TEXT,
    "imageFilePath" TEXT,
    "imageDownloadedAt" TIMESTAMP(3),
    "status" TEXT,
    "observations" TEXT,
    "rawData" JSONB,
    "extractedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publicationStatus" TEXT,

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

-- CreateTable
CREATE TABLE "Store" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" "StorePlatform" NOT NULL,
    "url" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "credentials" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Store_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreIntegration" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "config" TEXT,
    "consumerKeyEncrypted" TEXT,
    "consumerSecretEncrypted" TEXT,
    "status" TEXT,
    "lastConnectionCheck" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoreCategory" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "externalCategoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "parentExternalId" TEXT,
    "parentId" TEXT,
    "categoryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StoreCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UnmatchedStoreProduct" (
    "id" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "externalProductId" TEXT NOT NULL,
    "externalSku" TEXT,
    "name" TEXT NOT NULL,
    "price" DOUBLE PRECISION,
    "stockQuantity" INTEGER,
    "imageUrl" TEXT,
    "categories" TEXT,
    "permalink" TEXT,
    "externalStatus" TEXT,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UnmatchedStoreProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogProduct" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "sku" TEXT,
    "publicationSku" TEXT,
    "productUrl" TEXT,
    "identityHash" TEXT,
    "sourceType" "CatalogSourceType" NOT NULL DEFAULT 'SCRAPED',
    "manualSourceNote" TEXT,
    "importBatchId" TEXT,
    "stockSource" "StockSource" NOT NULL DEFAULT 'SUPPLIER',
    "sourceCatalogProductId" TEXT,
    "supplierName" TEXT NOT NULL,
    "supplierDescription" TEXT,
    "wholesalePrice" DOUBLE PRECISION,
    "stock" TEXT,
    "supplierCategory" TEXT,
    "imageUrl" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,
    "supplierStatus" "CatalogProductStatus" NOT NULL DEFAULT 'ACTIVE',
    "internalStatus" "InternalPublicationStatus" NOT NULL DEFAULT 'NOT_PUBLISHED',
    "pausedBySystem" BOOLEAN NOT NULL DEFAULT false,
    "latestExtractedProductId" TEXT,
    "commercialTitle" TEXT,
    "commercialName" TEXT,
    "commercialDescription" TEXT,
    "assignedCategoryId" TEXT,
    "manualPrice" DOUBLE PRECISION,
    "manualMargin" DOUBLE PRECISION,
    "finalPrice" DOUBLE PRECISION,
    "pricingRuleId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProductPublication" (
    "id" TEXT NOT NULL,
    "catalogProductId" TEXT NOT NULL,
    "storeId" TEXT NOT NULL,
    "status" "PublicationStatus" NOT NULL DEFAULT 'DRAFT',
    "externalProductId" TEXT,
    "externalVariantId" TEXT,
    "externalSku" TEXT,
    "sku" TEXT,
    "externalStatus" TEXT,
    "externalUrl" TEXT,
    "publishedAt" TIMESTAMP(3),
    "pausedAt" TIMESTAMP(3),
    "lastSyncAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "syncError" TEXT,
    "errorMessage" TEXT,
    "priceInStore" DOUBLE PRECISION,
    "stockInStore" INTEGER,
    "categoryInStore" TEXT,
    "commercialTitle" TEXT,
    "commercialTitleUserEdited" BOOLEAN NOT NULL DEFAULT false,
    "commercialDescription" TEXT,
    "commercialDescriptionUserEdited" BOOLEAN NOT NULL DEFAULT false,
    "pendingSync" BOOLEAN NOT NULL DEFAULT false,
    "syncStatus" "PublicationSyncStatus" NOT NULL DEFAULT 'READY',
    "finalPrice" DOUBLE PRECISION,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProductPublication_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogProductImage" (
    "id" TEXT NOT NULL,
    "catalogProductId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "source" "ImageSource" NOT NULL DEFAULT 'SUPPLIER',
    "altText" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogProductImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingRule" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "scope" "PricingRuleScope" NOT NULL,
    "scopeId" TEXT,
    "marginPercent" DOUBLE PRECISION NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'MARKUP_ON_COST',
    "roundingMode" "RoundingMode" NOT NULL DEFAULT 'NONE',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PricingRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "parentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogProductCategory" (
    "catalogProductId" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CatalogProductCategory_pkey" PRIMARY KEY ("catalogProductId","categoryId")
);

-- CreateTable
CREATE TABLE "ProductCategoryMapping" (
    "id" TEXT NOT NULL,
    "providerCategory" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProductCategoryMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EventLog" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "severity" "EventSeverity" NOT NULL,
    "source" "EventSource" NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "userId" TEXT,
    "providerId" TEXT,
    "productId" TEXT,
    "publicationId" TEXT,
    "storeId" TEXT,
    "jobId" TEXT,
    "metadata" JSONB,

    CONSTRAINT "EventLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Provider_userId_idx" ON "Provider"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "ProviderScraperConfig_providerId_key" ON "ProviderScraperConfig"("providerId");

-- CreateIndex
CREATE INDEX "ExtractionJob_status_createdAt_idx" ON "ExtractionJob"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ExtractionJob_userId_idx" ON "ExtractionJob"("userId");

-- CreateIndex
CREATE INDEX "ExtractionJob_source_idx" ON "ExtractionJob"("source");

-- CreateIndex
CREATE INDEX "ExtractionJob_importBatchId_idx" ON "ExtractionJob"("importBatchId");

-- CreateIndex
CREATE UNIQUE INDEX "ExtractionComparison_jobId_key" ON "ExtractionComparison"("jobId");

-- CreateIndex
CREATE INDEX "ProductChange_comparisonId_idx" ON "ProductChange"("comparisonId");

-- CreateIndex
CREATE INDEX "ProductChange_comparisonId_changeType_idx" ON "ProductChange"("comparisonId", "changeType");

-- CreateIndex
CREATE INDEX "ProductChange_sku_idx" ON "ProductChange"("sku");

-- CreateIndex
CREATE INDEX "ProductChange_changeType_idx" ON "ProductChange"("changeType");

-- CreateIndex
CREATE INDEX "ProductChange_createdAt_idx" ON "ProductChange"("createdAt");

-- CreateIndex
CREATE INDEX "ProductChange_reviewStatus_idx" ON "ProductChange"("reviewStatus");

-- CreateIndex
CREATE INDEX "ProductChange_changeType_reviewStatus_idx" ON "ProductChange"("changeType", "reviewStatus");

-- CreateIndex
CREATE INDEX "ProductChange_importBatchId_idx" ON "ProductChange"("importBatchId");

-- CreateIndex
CREATE INDEX "ExtractedProduct_jobId_idx" ON "ExtractedProduct"("jobId");

-- CreateIndex
CREATE INDEX "ExtractedProduct_providerId_idx" ON "ExtractedProduct"("providerId");

-- CreateIndex
CREATE INDEX "ExtractedProduct_sku_idx" ON "ExtractedProduct"("sku");

-- CreateIndex
CREATE INDEX "ExtractionLog_jobId_idx" ON "ExtractionLog"("jobId");

-- CreateIndex
CREATE INDEX "Store_userId_idx" ON "Store"("userId");

-- CreateIndex
CREATE INDEX "Store_userId_platform_idx" ON "Store"("userId", "platform");

-- CreateIndex
CREATE INDEX "StoreIntegration_storeId_idx" ON "StoreIntegration"("storeId");

-- CreateIndex
CREATE INDEX "StoreCategory_storeId_idx" ON "StoreCategory"("storeId");

-- CreateIndex
CREATE INDEX "StoreCategory_parentId_idx" ON "StoreCategory"("parentId");

-- CreateIndex
CREATE INDEX "StoreCategory_parentExternalId_idx" ON "StoreCategory"("parentExternalId");

-- CreateIndex
CREATE INDEX "StoreCategory_categoryId_idx" ON "StoreCategory"("categoryId");

-- CreateIndex
CREATE UNIQUE INDEX "StoreCategory_storeId_externalCategoryId_key" ON "StoreCategory"("storeId", "externalCategoryId");

-- CreateIndex
CREATE INDEX "UnmatchedStoreProduct_storeId_idx" ON "UnmatchedStoreProduct"("storeId");

-- CreateIndex
CREATE INDEX "UnmatchedStoreProduct_storeId_resolved_idx" ON "UnmatchedStoreProduct"("storeId", "resolved");

-- CreateIndex
CREATE UNIQUE INDEX "UnmatchedStoreProduct_storeId_externalProductId_key" ON "UnmatchedStoreProduct"("storeId", "externalProductId");

-- CreateIndex
CREATE INDEX "CatalogProduct_userId_idx" ON "CatalogProduct"("userId");

-- CreateIndex
CREATE INDEX "CatalogProduct_providerId_idx" ON "CatalogProduct"("providerId");

-- CreateIndex
CREATE INDEX "CatalogProduct_supplierStatus_idx" ON "CatalogProduct"("supplierStatus");

-- CreateIndex
CREATE INDEX "CatalogProduct_userId_providerId_idx" ON "CatalogProduct"("userId", "providerId");

-- CreateIndex
CREATE INDEX "CatalogProduct_internalStatus_idx" ON "CatalogProduct"("internalStatus");

-- CreateIndex
CREATE INDEX "CatalogProduct_userId_internalStatus_idx" ON "CatalogProduct"("userId", "internalStatus");

-- CreateIndex
CREATE INDEX "CatalogProduct_userId_publicationSku_idx" ON "CatalogProduct"("userId", "publicationSku");

-- CreateIndex
CREATE INDEX "CatalogProduct_userId_sourceType_idx" ON "CatalogProduct"("userId", "sourceType");

-- CreateIndex
CREATE INDEX "CatalogProduct_importBatchId_idx" ON "CatalogProduct"("importBatchId");

-- CreateIndex
CREATE INDEX "CatalogProduct_sourceCatalogProductId_idx" ON "CatalogProduct"("sourceCatalogProductId");

-- CreateIndex
CREATE INDEX "CatalogProduct_userId_stockSource_idx" ON "CatalogProduct"("userId", "stockSource");

-- CreateIndex
CREATE UNIQUE INDEX "CatalogProduct_userId_providerId_sku_key" ON "CatalogProduct"("userId", "providerId", "sku");

-- CreateIndex
CREATE INDEX "ProductPublication_catalogProductId_idx" ON "ProductPublication"("catalogProductId");

-- CreateIndex
CREATE INDEX "ProductPublication_storeId_idx" ON "ProductPublication"("storeId");

-- CreateIndex
CREATE INDEX "ProductPublication_status_idx" ON "ProductPublication"("status");

-- CreateIndex
CREATE INDEX "ProductPublication_storeId_pendingSync_idx" ON "ProductPublication"("storeId", "pendingSync");

-- CreateIndex
CREATE INDEX "ProductPublication_storeId_externalStatus_idx" ON "ProductPublication"("storeId", "externalStatus");

-- CreateIndex
CREATE INDEX "ProductPublication_storeId_syncStatus_idx" ON "ProductPublication"("storeId", "syncStatus");

-- CreateIndex
CREATE UNIQUE INDEX "ProductPublication_catalogProductId_storeId_key" ON "ProductPublication"("catalogProductId", "storeId");

-- CreateIndex
CREATE INDEX "CatalogProductImage_catalogProductId_idx" ON "CatalogProductImage"("catalogProductId");

-- CreateIndex
CREATE INDEX "CatalogProductImage_catalogProductId_position_idx" ON "CatalogProductImage"("catalogProductId", "position");

-- CreateIndex
CREATE INDEX "PricingRule_userId_idx" ON "PricingRule"("userId");

-- CreateIndex
CREATE INDEX "PricingRule_userId_scope_idx" ON "PricingRule"("userId", "scope");

-- CreateIndex
CREATE INDEX "PricingRule_userId_isActive_idx" ON "PricingRule"("userId", "isActive");

-- CreateIndex
CREATE INDEX "CatalogProductCategory_catalogProductId_idx" ON "CatalogProductCategory"("catalogProductId");

-- CreateIndex
CREATE INDEX "CatalogProductCategory_categoryId_idx" ON "CatalogProductCategory"("categoryId");

-- CreateIndex
CREATE INDEX "CatalogProductCategory_catalogProductId_isPrimary_idx" ON "CatalogProductCategory"("catalogProductId", "isPrimary");

-- CreateIndex
CREATE INDEX "EventLog_createdAt_idx" ON "EventLog"("createdAt");

-- CreateIndex
CREATE INDEX "EventLog_severity_idx" ON "EventLog"("severity");

-- CreateIndex
CREATE INDEX "EventLog_source_idx" ON "EventLog"("source");

-- CreateIndex
CREATE INDEX "EventLog_providerId_idx" ON "EventLog"("providerId");

-- CreateIndex
CREATE INDEX "EventLog_productId_idx" ON "EventLog"("productId");

-- CreateIndex
CREATE INDEX "EventLog_publicationId_idx" ON "EventLog"("publicationId");

-- CreateIndex
CREATE INDEX "EventLog_storeId_idx" ON "EventLog"("storeId");

-- CreateIndex
CREATE INDEX "EventLog_jobId_idx" ON "EventLog"("jobId");

-- AddForeignKey
ALTER TABLE "Provider" ADD CONSTRAINT "Provider_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProviderScraperConfig" ADD CONSTRAINT "ProviderScraperConfig_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionJob" ADD CONSTRAINT "ExtractionJob_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionJob" ADD CONSTRAINT "ExtractionJob_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionComparison" ADD CONSTRAINT "ExtractionComparison_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ExtractionJob"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionComparison" ADD CONSTRAINT "ExtractionComparison_previousJobId_fkey" FOREIGN KEY ("previousJobId") REFERENCES "ExtractionJob"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductChange" ADD CONSTRAINT "ProductChange_comparisonId_fkey" FOREIGN KEY ("comparisonId") REFERENCES "ExtractionComparison"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractedProduct" ADD CONSTRAINT "ExtractedProduct_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ExtractionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExtractionLog" ADD CONSTRAINT "ExtractionLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ExtractionJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Store" ADD CONSTRAINT "Store_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreIntegration" ADD CONSTRAINT "StoreIntegration_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreCategory" ADD CONSTRAINT "StoreCategory_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreCategory" ADD CONSTRAINT "StoreCategory_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "StoreCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreCategory" ADD CONSTRAINT "StoreCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UnmatchedStoreProduct" ADD CONSTRAINT "UnmatchedStoreProduct_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogProduct" ADD CONSTRAINT "CatalogProduct_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogProduct" ADD CONSTRAINT "CatalogProduct_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogProduct" ADD CONSTRAINT "CatalogProduct_sourceCatalogProductId_fkey" FOREIGN KEY ("sourceCatalogProductId") REFERENCES "CatalogProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogProduct" ADD CONSTRAINT "CatalogProduct_latestExtractedProductId_fkey" FOREIGN KEY ("latestExtractedProductId") REFERENCES "ExtractedProduct"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogProduct" ADD CONSTRAINT "CatalogProduct_assignedCategoryId_fkey" FOREIGN KEY ("assignedCategoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogProduct" ADD CONSTRAINT "CatalogProduct_pricingRuleId_fkey" FOREIGN KEY ("pricingRuleId") REFERENCES "PricingRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPublication" ADD CONSTRAINT "ProductPublication_catalogProductId_fkey" FOREIGN KEY ("catalogProductId") REFERENCES "CatalogProduct"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductPublication" ADD CONSTRAINT "ProductPublication_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogProductImage" ADD CONSTRAINT "CatalogProductImage_catalogProductId_fkey" FOREIGN KEY ("catalogProductId") REFERENCES "CatalogProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRule" ADD CONSTRAINT "PricingRule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Category" ADD CONSTRAINT "Category_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogProductCategory" ADD CONSTRAINT "CatalogProductCategory_catalogProductId_fkey" FOREIGN KEY ("catalogProductId") REFERENCES "CatalogProduct"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogProductCategory" ADD CONSTRAINT "CatalogProductCategory_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProductCategoryMapping" ADD CONSTRAINT "ProductCategoryMapping_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventLog" ADD CONSTRAINT "EventLog_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EventLog" ADD CONSTRAINT "EventLog_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "Provider"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EventLog" ADD CONSTRAINT "EventLog_productId_fkey" FOREIGN KEY ("productId") REFERENCES "CatalogProduct"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EventLog" ADD CONSTRAINT "EventLog_publicationId_fkey" FOREIGN KEY ("publicationId") REFERENCES "ProductPublication"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EventLog" ADD CONSTRAINT "EventLog_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "EventLog" ADD CONSTRAINT "EventLog_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ExtractionJob"("id") ON DELETE NO ACTION ON UPDATE NO ACTION;

