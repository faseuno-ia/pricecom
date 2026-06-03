-- Fase 4B guard 3: nuevo estado distinguible para cuando el SKU canónico
-- colisiona con un producto ya existente en la tienda externa (no transitorio).
ALTER TYPE "PublicationSyncStatus" ADD VALUE 'ERROR_SKU_CONFLICT';
