-- AlterTable
ALTER TABLE "ProviderScraperConfig" ADD COLUMN     "extractionMode" TEXT,
ADD COLUMN     "loginFlowStrategy" TEXT,
ADD COLUMN     "loginUrl" TEXT;
