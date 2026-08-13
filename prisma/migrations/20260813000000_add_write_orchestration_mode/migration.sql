-- 2G-R10-PR19 · Autoridad de ORQUESTADOR por proveedor (config-driven, explícita).
-- Columna nullable TEXT, SIN default, SIN backfill, SIN enum. ADDITIVE-ONLY / backward-compatible:
-- el código viejo ignora la columna; el código nuevo resuelve null → LEGACY (conducta histórica, sin
-- cambio de conducta para ningún proveedor al desplegar). El opt-in a "GUARDED_PRICE_ONLY" es un UPDATE
-- posterior por proveedor, fuera de esta migración.
ALTER TABLE "ProviderScraperConfig" ADD COLUMN "writeOrchestrationMode" TEXT;
