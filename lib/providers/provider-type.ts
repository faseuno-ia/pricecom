import type { ProviderType } from "@prisma/client";

/**
 * "Extraíble" = fuente de catálogo alimentada por extracción automática: el
 * worker corre un ExtractionJob y produce ScrapedProduct[]. Hoy son SCRAPER
 * (scraping HTML con Playwright) y WOO_STORE_API (JSON de la Store API).
 *
 * Ambas comparten comportamiento: botón "Extraer", historial de extracciones,
 * Excel generado por el worker, y quedan EXCLUIDAS de las acciones manuales
 * de catálogo (marcar sin stock / aplicar costo) porque el catálogo lo gobierna
 * el proveedor, no el usuario.
 *
 * Pura (sin deps de runtime) → importable tanto desde server components como
 * desde API routes.
 */
export function isExtractableProvider(providerType: ProviderType): boolean {
  return providerType === "SCRAPER" || providerType === "WOO_STORE_API";
}

/**
 * "Tiene selectores" = SOLO SCRAPER. WOO_STORE_API es extraíble pero NO tiene
 * ProviderScraperConfig (consume JSON, no parsea HTML), por lo que no muestra
 * el gear/link de configuración de selectores. Concepto distinto de
 * isExtractableProvider — no colapsarlos.
 */
export function hasScraperSelectors(providerType: ProviderType): boolean {
  return providerType === "SCRAPER";
}
