-- 2G-R7.2 · Autoridad de escritura del catálogo (config-driven).
-- Columna nullable TEXT, SIN default, SIN backfill, SIN enum. Backward-compatible: el código viejo
-- ignora la columna; el código nuevo resuelve null → FULL (conducta histórica).
ALTER TABLE "ProviderScraperConfig" ADD COLUMN "catalogWriteMode" TEXT;
