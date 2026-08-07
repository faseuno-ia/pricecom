// 2G-R6 / R6-R1 — Harness diagnóstico READ-ONLY para la captura SKU-first autenticada de DT.
//
// FIDELIDAD (R6-R1 / R6-R1.1): el brazo FAST usa la UNIDAD PRODUCTIVA DE CAPTURA POR FICHA — el
// `captureProductRows` del walker (lib/scraper/tiendanube-walker.ts) — dentro de un LOOP DIAGNÓSTICO
// (no ejecuta el `runSkuFirstWalk` completo). Nomenclatura exacta:
//   FAST_PRODUCT_CAPTURE_SEQUENCE = PRODUCTIVE_CAPTURE_PRODUCT_ROWS  (PRODUCT_CAPTURE_PATH_FIDELITY=HIGH)
//   FAST_INTER_PRODUCT_ORCHESTRATION = DIAGNOSTIC_LOOP               (FULL_WALK_ORCHESTRATION_FIDELITY=PARTIAL)
// Inyecta deps que reutilizan navegación (page.goto domcontentloaded), re-login real y el lector real
// window.LS (ScraperService.captureLsPayload). Sin waits/polls/probe-navs dentro del brazo (sesión
// side-effect-free: checkpoints pre/post + señal intermedia derivada de records).
//
// ROL: FUNCTIONAL_VALIDATION_NOT_PRODUCTION_REGIME_REPRODUCTION. El wall-clock LOCAL (Windows) NO es
// comparable causalmente con la ejecución histórica en Railway; un 0/N local NO refuta un defecto
// productivo, y la diferencia de ms/producto es DESCRIPTIVA, sin significado causal.
//
// CERO writes DB/Provider/Job/Woo. Un solo browser, red serial. Output sólo conteos (nunca
// precios/cookies/tokens/HTML).
import type { Page } from "playwright";
import { captureProductRows, type WalkerDeps, type RawLsPagePayload } from "../scraper/tiendanube-walker";

export interface UrlRecord {
  canonicalUrl: string;
  ordinal: number;
  historicalOrdinal: number | null;
  navStatus: number | null;
  finalUrl: string | null;
  redirectedToLogin: boolean;
  authWitness: boolean; // PRICING_CAPABILITY_WITNESS: ≥1 variante con precio válido (>0)
  initialVariantCount: number;
  variantSkuCount: number;
  validPriceVariantCount: number;
  firstNonzeroVariantAtMs: number | null; // sólo zero-replay
  challengeWitness: boolean;
  http429: boolean;
  retryAfterObserved: boolean;
  connectionReset: boolean;
  errorClass: string | null;
  elapsedMs: number;
}

export interface ArmAgg {
  urlCount: number; navSuccessCount: number; initialZeroVariantCount: number; nonzeroVariantCount: number;
  variantTotal: number; validPriceVariantCount: number; urlsWithAnyValidPrice: number;
  sessionLossCount: number; http429Count: number; retryAfterCount: number; challengeCount: number;
  connectionResetCount: number; firstZeroOrdinal: number | null;
}
export interface ArmCadence { meanMsPerProduct: number; medianMsPerProduct: number; sumElapsedMs: number; wallClockMs: number | null; }
export interface ArmResult { records: UrlRecord[]; agg: ArmAgg; cadence: ArmCadence; }

export interface ZeroReplayRecord {
  canonicalUrl: string; initialVariantCount: number;
  at250: number; at500: number; at1000: number; at2000: number; at5000: number;
  firstNonzeroVariantAtMs: number | 250 | 500 | 1000 | 2000 | 5000 | null;
  authWitnessT0: boolean; authWitnessFinal: boolean; finalUrlChanged: boolean;
}
export interface ZeroReplayAgg {
  executed: boolean; urlCount: number; recoveredWithoutReloadCount: number; neverRecoveredCount: number;
  maxRecoveryMs: number | null; recoveryDistribution: Record<string, number>;
}

/** Lector real window.LS (vía instancia de ScraperService; NO se copia la extracción). */
export interface LsReader { capture: () => Promise<{ variants: unknown[] }>; }

const isValidPrice = (p: unknown): boolean => typeof p === "number" && Number.isFinite(p) && p > 0;
const median = (a: number[]) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

export function classifyError(err: unknown): string {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (m.includes("econnreset") || m.includes("connection reset") || m.includes("err_connection_reset")) return "CONNECTION_RESET";
  if (m.includes("timeout") || m.includes("timed out")) return "TIMEOUT";
  if (m.includes("err_connection") || m.includes("net::")) return "NET_ERROR";
  return "OTHER";
}

interface NavSink { status: number | null; finalUrl: string | null; redirectedToLogin: boolean; http429: boolean; retryAfter: boolean; reset: boolean; errorClass: string | null; }
const resetSink = (s: NavSink) => { s.status = null; s.finalUrl = null; s.redirectedToLogin = false; s.http429 = false; s.retryAfter = false; s.reset = false; s.errorClass = null; };

/**
 * Construye WalkerDeps para `captureProductRows` (la unidad productiva por ficha). Sólo se usan
 * navigateToProduct / reLogin / captureLsPayload / maxProductRetries / now / onLog; el resto son
 * stubs inertes (captureProductRows NUNCA los llama). navigateToProduct instrumenta status/429/
 * retry-after/reset en `sink` y re-lanza los throws para que captureProductRows haga su retry real.
 */
function buildFichaDeps(page: Page, reader: LsReader, reLogin: () => Promise<void>, baseUrl: string, sink: NavSink): WalkerDeps {
  return {
    extractListingProductUrls: async () => [],
    resolveUrl: (h) => h,
    goToNextListing: async () => false,
    maxListingPages: 0,
    navigateToProduct: async (url: string) => {
      try {
        const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
        sink.status = resp?.status() ?? null;
        if (resp?.status() === 429) sink.http429 = true;
        const h = resp?.headers?.() ?? {};
        if (h["retry-after"] !== undefined) sink.retryAfter = true;
        const finalUrl = page.url();
        sink.finalUrl = finalUrl;
        sink.redirectedToLogin = finalUrl.includes("login") || finalUrl === baseUrl;
        return { redirectedToLogin: sink.redirectedToLogin };
      } catch (e) {
        const cls = classifyError(e);
        sink.errorClass = cls;
        if (cls === "CONNECTION_RESET") sink.reset = true;
        throw e; // captureProductRows maneja retry/null (comportamiento productivo)
      }
    },
    reLogin,
    captureLsPayload: () => reader.capture() as Promise<RawLsPagePayload>,
    maxProductRetries: 2, // idéntico al worker productivo
    now: () => new Date().toISOString(),
    isCancelled: () => false,
    onLog: async () => {},
    onProgress: async () => {},
  };
}

/**
 * Corre un brazo SOBRE LA ORQUESTACIÓN PRODUCTIVA (`captureProductRows`) con delay inter-ficha
 * opcional. SIN probe-navs ni checkpoints dentro del brazo (cadencia = walk puro del worker).
 * La sesión se observa side-effect-free: derivada de `redirectedToLogin` en los records (el
 * caller hace los checkpoints pre/post fuera del brazo).
 */
export async function runArm(
  page: Page, reader: LsReader, reLogin: () => Promise<void>,
  cohort: { canonicalUrl: string; historicalOrdinal: number | null }[],
  opts: { interProductDelayMs: number; baseUrl: string; onProgress?: (i: number, rec: UrlRecord) => void },
): Promise<ArmResult> {
  const records: UrlRecord[] = [];
  const sink: NavSink = { status: null, finalUrl: null, redirectedToLogin: false, http429: false, retryAfter: false, reset: false, errorClass: null };
  const deps = buildFichaDeps(page, reader, reLogin, opts.baseUrl, sink);
  const wallStart = Date.now();
  for (let i = 0; i < cohort.length; i++) {
    if (i > 0 && opts.interProductDelayMs > 0) await page.waitForTimeout(opts.interProductDelayMs);
    resetSink(sink);
    const t0 = Date.now();
    const rows = await captureProductRows(cohort[i].canonicalUrl, i, deps); // unidad productiva
    const elapsed = Date.now() - t0;
    const initial = rows === null ? 0 : rows.length;
    const skuCount = rows === null ? 0 : rows.filter((r: any) => typeof r.rawSku === "string" && r.rawSku.trim().length > 0).length;
    const validPrice = rows === null ? 0 : rows.filter((r: any) => isValidPrice(r.priceNumber)).length;
    const rec: UrlRecord = {
      canonicalUrl: cohort[i].canonicalUrl, ordinal: i, historicalOrdinal: cohort[i].historicalOrdinal,
      navStatus: sink.status, finalUrl: sink.finalUrl, redirectedToLogin: sink.redirectedToLogin,
      authWitness: validPrice > 0, initialVariantCount: initial, variantSkuCount: skuCount,
      validPriceVariantCount: validPrice, firstNonzeroVariantAtMs: null, challengeWitness: sink.http429,
      http429: sink.http429, retryAfterObserved: sink.retryAfter, connectionReset: sink.reset,
      // rows===null → falla de navegación definitiva (errorClass); rows===[] → LS vacío (capture failure, errorClass null)
      errorClass: rows === null ? (sink.errorClass ?? "CAPTURE_FAILED_AFTER_RETRIES") : null,
      elapsedMs: elapsed,
    };
    records.push(rec);
    opts.onProgress?.(i, rec);
  }
  const wallClockMs = Date.now() - wallStart;
  const el = records.map((r) => r.elapsedMs);
  return {
    records,
    agg: aggregate(records),
    cadence: { meanMsPerProduct: el.length ? el.reduce((a, b) => a + b, 0) / el.length : 0, medianMsPerProduct: median(el), sumElapsedMs: el.reduce((a, b) => a + b, 0), wallClockMs },
  };
}

/** Checkpoint de sesión PACIENTE (fuera del brazo): navega al probe, espera LS, mide precio. */
export async function sessionCheckpoint(page: Page, reader: LsReader, probeUrl: string, baseUrl: string): Promise<boolean> {
  try {
    await page.goto(probeUrl, { waitUntil: "domcontentloaded" });
    const finalUrl = page.url();
    if (finalUrl.includes("login") || finalUrl === baseUrl) return false;
    await page.waitForFunction(
      `(function(){var LS=(typeof window!=="undefined"&&window.LS)||{};return Array.isArray(LS.variants)&&LS.variants.length>0;})()`,
      { timeout: 5000 },
    ).catch(() => {});
    const payload = await reader.capture();
    return (payload.variants ?? []).some((v: any) => isValidPrice(v?.price_number));
  } catch { return false; }
}

/** ZERO-REPLAY: re-lee window.LS del MISMO documento a 250/500/1000/2000/5000ms, SIN reload. */
export async function zeroReplay(page: Page, reader: LsReader, zeroUrls: string[], _baseUrl: string): Promise<{ records: ZeroReplayRecord[]; agg: ZeroReplayAgg }> {
  const records: ZeroReplayRecord[] = [];
  const times = [250, 500, 1000, 2000, 5000] as const;
  const priceVisible = (vs: unknown[]) => vs.some((v: any) => isValidPrice(v?.price_number));
  for (const url of zeroUrls) {
    const r: ZeroReplayRecord = { canonicalUrl: url, initialVariantCount: 0, at250: 0, at500: 0, at1000: 0, at2000: 0, at5000: 0, firstNonzeroVariantAtMs: null, authWitnessT0: false, authWitnessFinal: false, finalUrlChanged: false };
    let navOk = true;
    try { await page.goto(url, { waitUntil: "domcontentloaded" }); } catch { navOk = false; }
    if (!navOk) { records.push(r); continue; }
    const startUrl = page.url();
    const p0 = await reader.capture().catch(() => ({ variants: [] as unknown[] }));
    r.initialVariantCount = (p0.variants ?? []).length;
    r.authWitnessT0 = priceVisible(p0.variants ?? []);
    let prev = 0;
    const buckets: Record<number, number> = {};
    for (const t of times) {
      await page.waitForTimeout(t - prev); prev = t;
      const p = await reader.capture().catch(() => ({ variants: [] as unknown[] }));
      const n = (p.variants ?? []).length;
      buckets[t] = n;
      if (r.firstNonzeroVariantAtMs === null && n > 0) r.firstNonzeroVariantAtMs = t;
    }
    r.at250 = buckets[250]; r.at500 = buckets[500]; r.at1000 = buckets[1000]; r.at2000 = buckets[2000]; r.at5000 = buckets[5000];
    const pf = await reader.capture().catch(() => ({ variants: [] as unknown[] }));
    r.authWitnessFinal = priceVisible(pf.variants ?? []);
    r.finalUrlChanged = page.url() !== startUrl;
    if (r.initialVariantCount > 0) r.firstNonzeroVariantAtMs = 0;
    records.push(r);
  }
  const recovered = records.filter((r) => r.initialVariantCount === 0 && r.firstNonzeroVariantAtMs !== null && r.firstNonzeroVariantAtMs !== 0);
  const never = records.filter((r) => r.initialVariantCount === 0 && r.firstNonzeroVariantAtMs === null);
  const dist: Record<string, number> = { "250": 0, "500": 0, "1000": 0, "2000": 0, "5000": 0, NEVER: 0 };
  for (const r of records) { if (r.initialVariantCount > 0) continue; if (r.firstNonzeroVariantAtMs === null) dist.NEVER++; else dist[String(r.firstNonzeroVariantAtMs)]++; }
  const maxRecoveryMs = recovered.length ? Math.max(...recovered.map((r) => Number(r.firstNonzeroVariantAtMs))) : null;
  return { records, agg: { executed: true, urlCount: records.length, recoveredWithoutReloadCount: recovered.length, neverRecoveredCount: never.length, maxRecoveryMs, recoveryDistribution: dist } };
}

export function aggregate(records: UrlRecord[]): ArmAgg {
  const firstZero = records.find((r) => r.errorClass === null && r.initialVariantCount === 0);
  return {
    urlCount: records.length,
    navSuccessCount: records.filter((r) => r.errorClass === null && r.navStatus !== null).length,
    initialZeroVariantCount: records.filter((r) => r.errorClass === null && r.initialVariantCount === 0).length,
    nonzeroVariantCount: records.filter((r) => r.initialVariantCount > 0).length,
    variantTotal: records.reduce((a, r) => a + r.initialVariantCount, 0),
    validPriceVariantCount: records.reduce((a, r) => a + r.validPriceVariantCount, 0),
    urlsWithAnyValidPrice: records.filter((r) => r.validPriceVariantCount > 0).length,
    // sesión side-effect-free: derivada de redirecciones a login en el propio recorrido (sin probe-navs)
    sessionLossCount: records.filter((r) => r.redirectedToLogin).length,
    http429Count: records.filter((r) => r.http429).length,
    retryAfterCount: records.filter((r) => r.retryAfterObserved).length,
    challengeCount: records.filter((r) => r.challengeWitness).length,
    connectionResetCount: records.filter((r) => r.connectionReset).length,
    firstZeroOrdinal: firstZero ? firstZero.ordinal : null,
  };
}
