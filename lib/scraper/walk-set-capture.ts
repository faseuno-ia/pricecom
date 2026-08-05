// G1 — decisión PURA de aceptación de una captura para el WALK_SET (instrumentación del
// scraper.service). Aislada acá para poder testear la lógica real sin Playwright.
//
// WALK_SET_SEMANTICS = PRODUCT_DETAIL_URLS_SUCCESSFULLY_CAPTURED_AND_ACCEPTED.
import { normalizeCatalogUrl } from "./url-normalization";
import { isProductDetailUrl } from "./runtime-sitemap-reference";

/** Shape mínimo del payload que este helper inspecciona. */
export interface CapturedPayloadLike {
  variants: unknown;
  productUrl?: unknown;
}

/**
 * Devuelve la URL normalizada a registrar en el WALK_SET, o `null` si la captura NO se acepta.
 * Acepta SOLO si (§5/§6):
 *   payload con ≥1 variante (lo que el walker mapea a filas),
 *   e identidad de URL coherente:
 *     ambas (payload.productUrl, page.url()) válidas y equivalentes → registra el normalizado;
 *     solo una válida → la válida;
 *     ambas válidas pero distintas → identity mismatch → null (no registra).
 *   La URL elegida debe pasar el predicado de producto y normalizar no-null.
 * Un throw de captureLsPayload (timeout/404/redirect-a-login/payload inválido) ocurre ANTES de
 * llamar acá → nunca se registra. `variants.length===0` → null.
 */
export function acceptedCaptureUrl(payload: CapturedPayloadLike | null | undefined, pageUrl: string): string | null {
  if (!payload || !Array.isArray(payload.variants) || payload.variants.length === 0) return null;
  const rawPayloadUrl = typeof payload.productUrl === "string" ? payload.productUrl : null;
  const payloadOk = rawPayloadUrl !== null && isProductDetailUrl(rawPayloadUrl);
  const pageOk = typeof pageUrl === "string" && isProductDetailUrl(pageUrl);
  if (payloadOk && pageOk) {
    const np = normalizeCatalogUrl(rawPayloadUrl!);
    const ng = normalizeCatalogUrl(pageUrl);
    return np !== null && ng !== null && np === ng ? np : null; // distintas → identity mismatch
  }
  if (payloadOk) return normalizeCatalogUrl(rawPayloadUrl!);
  if (pageOk) return normalizeCatalogUrl(pageUrl);
  return null;
}
