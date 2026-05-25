-- Enums
CREATE TYPE "EventSeverity" AS ENUM ('INFO', 'WARNING', 'ERROR', 'CRITICAL');

CREATE TYPE "EventSource" AS ENUM (
  'USER',
  'WORKER',
  'SYSTEM',
  'SYNC',
  'IMPORT',
  'EXTRACTION',
  'WOOCOMMERCE'
);

-- EventLog: audit trail inmutable. Las FKs son ON DELETE NO ACTION (default
-- de Prisma cuando no se especifica): si se borra un Provider/Product/etc.
-- la fila huérfana de EventLog se conserva como registro histórico. Esto
-- requiere que ningún flujo borre entidades sin antes decidir qué hacer con
-- sus eventos (en práctica casi nada se hard-deletea en PricEcom).
CREATE TABLE "EventLog" (
  "id"            TEXT PRIMARY KEY,
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "severity"      "EventSeverity" NOT NULL,
  "source"        "EventSource" NOT NULL,
  "type"          TEXT NOT NULL,
  "title"         TEXT NOT NULL,
  "description"   TEXT,
  "userId"        TEXT,
  "providerId"    TEXT,
  "productId"     TEXT,
  "publicationId" TEXT,
  "storeId"       TEXT,
  "jobId"         TEXT,
  "metadata"      JSONB,

  CONSTRAINT "EventLog_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id"),
  CONSTRAINT "EventLog_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "Provider"("id"),
  CONSTRAINT "EventLog_productId_fkey"
    FOREIGN KEY ("productId") REFERENCES "CatalogProduct"("id"),
  CONSTRAINT "EventLog_publicationId_fkey"
    FOREIGN KEY ("publicationId") REFERENCES "ProductPublication"("id"),
  CONSTRAINT "EventLog_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id"),
  CONSTRAINT "EventLog_jobId_fkey"
    FOREIGN KEY ("jobId") REFERENCES "ExtractionJob"("id")
);

CREATE INDEX "EventLog_createdAt_idx" ON "EventLog"("createdAt");
CREATE INDEX "EventLog_severity_idx" ON "EventLog"("severity");
CREATE INDEX "EventLog_source_idx" ON "EventLog"("source");
CREATE INDEX "EventLog_providerId_idx" ON "EventLog"("providerId");
CREATE INDEX "EventLog_productId_idx" ON "EventLog"("productId");
CREATE INDEX "EventLog_publicationId_idx" ON "EventLog"("publicationId");
CREATE INDEX "EventLog_storeId_idx" ON "EventLog"("storeId");
CREATE INDEX "EventLog_jobId_idx" ON "EventLog"("jobId");
