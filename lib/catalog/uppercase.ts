// Mayuscularización canónica de datos de proveedor del catálogo.
//
// El cliente publica TODO en MAYÚSCULAS en Woo. Regla universal: supplierName y
// supplierDescription se almacenan en mayúsculas para TODOS los proveedores
// (scrapers HTML + WOO_STORE_API). Se aplica en upsertCatalogProducts, no en el
// scraper/extractor, para que la regla viva en un solo lugar.
//
// Usa toLocaleUpperCase("es-AR") para respetar acentos y ñ del español
// ("café" → "CAFÉ", "ñoño" → "ÑOÑO").

/** Pasa `value` a mayúsculas con locale es-AR. */
export function toCatalogUpperCase(value: string): string {
  return value.toLocaleUpperCase("es-AR");
}

/**
 * Mayúsculas con normalización de vacío a null: null/undefined/"" → null
 * (coherente con cómo supplierDescription vacía se guarda como null hoy).
 */
export function toCatalogUpperCaseOrNull(
  value: string | null | undefined
): string | null {
  if (value == null || value === "") return null;
  return value.toLocaleUpperCase("es-AR");
}
