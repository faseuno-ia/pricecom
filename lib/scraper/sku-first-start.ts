// G1 — orden SKU-first: SITEMAP_START se captura ANTES del login inicial, para que un START
// inválido impida el intento de login. Seam PURO (sin Playwright/Prisma/DB) para testear el
// orden sin browser. La error class vive acá (no en scraper.service) para que el worker pueda
// importarla sin arrastrar Playwright.
import { resolveExtractionMode } from "./tiendanube-sku-first";
import { fetchSitemapSnapshot, type SitemapFetchFn, type SitemapSnapshot } from "./runtime-sitemap-reference";
import type { TwoSnapshotDiagnostics } from "./sitemap-two-snapshot";

/**
 * Error operativo tipado de completitud SKU-first. Al lanzarse sale de `ScraperService.run`, lo
 * captura el worker y marca el job como fallido → CERO persistencia. Diagnósticos bounded
 * (counts + sample≤20 + SHA); nunca precios/HTML/credenciales.
 */
export class SkuFirstCompletenessError extends Error {
  readonly reasonCode: string;
  readonly diagnostics: Partial<TwoSnapshotDiagnostics> | Record<string, unknown>;
  constructor(reasonCode: string, diagnostics: Partial<TwoSnapshotDiagnostics> | Record<string, unknown>) {
    super(`SKU_FIRST_COMPLETENESS_FAILED: ${reasonCode}`);
    this.name = "SkuFirstCompletenessError";
    this.reasonCode = reasonCode;
    this.diagnostics = diagnostics;
  }
}

export interface SkuFirstStartOptions {
  extractionMode?: string | null;
  sitemapFetchFn?: SitemapFetchFn;
}

/**
 * Para SKU-first: exige `sitemapFetchFn`, fetchea SITEMAP_START y lo clasifica ANTES del login.
 *   FETCH_FAILED       → throw (impide login).
 *   EXPLICITLY_EMPTY   → throw R2_SITEMAP_REFERENCE_EXPLICITLY_EMPTY (impide login; reasonCode histórico).
 *   POPULATED          → devuelve el snapshot (el login puede continuar).
 * Para legacy (o modo no reconocido) → devuelve null y NO llama a `sitemapFetchFn` (fetchFn calls = 0).
 */
export async function prepareSkuFirstStartSnapshot(opts: SkuFirstStartOptions): Promise<SitemapSnapshot | null> {
  const mode = resolveExtractionMode(opts.extractionMode).mode;
  if (mode !== "TIENDANUBE_LS_VARIANTS_SKU_FIRST") return null;
  if (!opts.sitemapFetchFn) {
    throw new SkuFirstCompletenessError("R2_SITEMAP_FETCH_FN_MISSING", { mode });
  }
  const snap = await fetchSitemapSnapshot({ fetchFn: opts.sitemapFetchFn });
  if (snap.kind === "FETCH_FAILED") {
    throw new SkuFirstCompletenessError("R2_SITEMAP_START_FETCH_FAILED_" + snap.reason, { snapshot: "START" });
  }
  if (snap.kind === "EXPLICITLY_EMPTY") {
    throw new SkuFirstCompletenessError("R2_SITEMAP_REFERENCE_EXPLICITLY_EMPTY", { snapshot: "START" });
  }
  return snap; // POPULATED
}

/**
 * Serialización BOUNDED y sanitizada de los diagnósticos de un SkuFirstCompletenessError, para
 * que sobrevivan la frontera de fallo del job (EventLog). Solo reasonCode + counts + sample≤20 +
 * SHA + mínimo. Nunca listas completas, precios, HTML, cookies, tokens.
 */
export function sanitizeSkuFirstCompletenessDiagnostics(err: SkuFirstCompletenessError): Record<string, unknown> {
  const d = (err.diagnostics ?? {}) as Partial<TwoSnapshotDiagnostics> & Record<string, unknown>;
  const sample = Array.isArray(d.blockingMissingSample) ? d.blockingMissingSample.slice(0, 20) : undefined;
  const out: Record<string, unknown> = { reasonCode: err.reasonCode };
  for (const k of [
    "sitemapStartCount", "sitemapEndCount", "blockingSetCount", "walkSetCount",
    "blockingMissingCount", "addedDuringRunCount", "removedDuringRunCount", "minExpectedProducts",
    "blockingMissingSetSha256", "startSetSha256", "endSetSha256", "blockingSetSha256", "snapshot", "mode",
  ]) {
    if (d[k] !== undefined) out[k] = d[k];
  }
  if (sample !== undefined) out.blockingMissingSample = sample;
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// G1c — mensaje BOUNDED para el registro AUTORITATIVO del job fallido (markFailed).
// El campo persistido (ExtractionJob.errorMessage) es `text` (sin límite práctico);
// aun así acotamos defensivamente. El mensaje reutiliza el sanitizer whitelist
// (nunca listas completas/precios/HTML/cookies/tokens/credenciales/headers).
// ─────────────────────────────────────────────────────────────────────────────
export const SKU_FIRST_FAILURE_MESSAGE_MAX_CHARS = 4000;
const SKU_FIRST_FAILURE_PREFIX = "SKU_FIRST_COMPLETENESS_FAILED";
const SKU_FIRST_ESSENTIAL_COUNT_KEYS = [
  "sitemapStartCount", "sitemapEndCount", "blockingSetCount", "walkSetCount",
  "blockingMissingCount", "addedDuringRunCount", "removedDuringRunCount", "minExpectedProducts",
];
const SKU_FIRST_SHA_KEYS = ["blockingMissingSetSha256", "startSetSha256", "endSetSha256", "blockingSetSha256"];

/**
 * Construye el mensaje determinístico y bounded para markFailed a partir de un
 * SkuFirstCompletenessError. Empieza con `SKU_FIRST_COMPLETENESS_FAILED`, preserva
 * (en este orden de prioridad) reasonCode → conteos esenciales → SHA, y reduce/elimina
 * la muestra (≤20) al final para respetar `limit`. Nunca corta un SHA a la mitad ni
 * produce JSON inválido; en el piso patológico degrada a {reasonCode[, SHA]}.
 */
export function formatSkuFirstFailureMessage(err: SkuFirstCompletenessError, limit: number): string {
  const san = sanitizeSkuFirstCompletenessDiagnostics(err);
  const sample: unknown[] = Array.isArray(san.blockingMissingSample) ? (san.blockingMissingSample as unknown[]).slice(0, 20) : [];
  const build = (sampleLen: number, includeContext: boolean): string => {
    const obj: Record<string, unknown> = { reasonCode: san.reasonCode };
    for (const k of SKU_FIRST_ESSENTIAL_COUNT_KEYS) if (san[k] !== undefined) obj[k] = san[k];
    for (const k of SKU_FIRST_SHA_KEYS) if (san[k] !== undefined) obj[k] = san[k];
    if (includeContext) for (const k of ["snapshot", "mode"]) if (san[k] !== undefined) obj[k] = san[k];
    if (sampleLen > 0 && sample.length > 0) obj.blockingMissingSample = sample.slice(0, sampleLen);
    return `${SKU_FIRST_FAILURE_PREFIX} ${JSON.stringify(obj)}`;
  };
  // 1) completo (contexto + muestra full)
  let msg = build(sample.length, true);
  if (msg.length <= limit) return msg;
  // 2) reducir la muestra manteniendo reasonCode+conteos+SHA(+contexto)
  for (let n = sample.length - 1; n >= 0; n--) {
    msg = build(n, true);
    if (msg.length <= limit) return msg;
  }
  // 3) sin contexto ni muestra (reasonCode+conteos+SHA)
  msg = build(0, false);
  if (msg.length <= limit) return msg;
  // 4) piso: reasonCode + SHA principal (nunca cortar el SHA)
  const floor: Record<string, unknown> = { reasonCode: san.reasonCode };
  if (san.blockingMissingSetSha256 !== undefined) floor.blockingMissingSetSha256 = san.blockingMissingSetSha256;
  msg = `${SKU_FIRST_FAILURE_PREFIX} ${JSON.stringify(floor)}`;
  if (msg.length <= limit) return msg;
  // 5) piso absoluto: solo reasonCode (JSON válido; si el límite es patológico, no cortamos el JSON)
  return `${SKU_FIRST_FAILURE_PREFIX} ${JSON.stringify({ reasonCode: san.reasonCode })}`;
}

/**
 * Selección del mensaje para markFailed: SKU-first → mensaje bounded con diagnósticos;
 * cualquier otro error → `error.message` histórico EXACTO (comportamiento legacy intacto).
 */
export function selectFailureMessage(err: unknown, limit: number = SKU_FIRST_FAILURE_MESSAGE_MAX_CHARS): string {
  if (err instanceof SkuFirstCompletenessError) return formatSkuFirstFailureMessage(err, limit);
  return err instanceof Error ? err.message : String(err);
}
