// 2G-R6 — Harness diagnóstico READ-ONLY para la captura SKU-first autenticada de Different Touch.
// NO copia el scraper: reutiliza el lector real window.LS (ScraperService.captureLsPayload), los
// mappers productivos (mapProductPagePayloadToReducedRows) y el login real (performLogin). Mide,
// por URL y a cadencias controladas, el fenómeno "Ficha sin variantes (window.LS vacío)".
//
// CERO writes de DB / Provider / ExtractionJob. CERO Woo. Un solo browser, red serial (el caller
// garantiza que nunca corren dos brazos en paralelo). El output es seguro para conservar local:
// sólo conteos, nunca precios/cookies/tokens/HTML.
import type { Page } from "playwright";
import { mapProductPagePayloadToReducedRows } from "../scraper/tiendanube-walker";

// ── Tipos de registro ──────────────────────────────────────────────────────────
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
  urlCount: number;
  navSuccessCount: number;
  initialZeroVariantCount: number;
  nonzeroVariantCount: number;
  variantTotal: number;
  validPriceVariantCount: number;
  urlsWithAnyValidPrice: number;
  sessionLossCount: number;
  http429Count: number;
  retryAfterCount: number;
  challengeCount: number;
  connectionResetCount: number;
  firstZeroOrdinal: number | null;
}

export interface SessionCheckpoint { ordinalBefore: number; authWitness: boolean; }
export interface ArmResult { records: UrlRecord[]; agg: ArmAgg; checkpoints: SessionCheckpoint[]; }

export interface ZeroReplayRecord {
  canonicalUrl: string;
  initialVariantCount: number;
  at250: number; at500: number; at1000: number; at2000: number; at5000: number;
  firstNonzeroVariantAtMs: number | 250 | 500 | 1000 | 2000 | 5000 | null; // null = NEVER
  authWitnessT0: boolean; authWitnessFinal: boolean; finalUrlChanged: boolean;
}
export interface ZeroReplayAgg {
  executed: boolean; urlCount: number; recoveredWithoutReloadCount: number; neverRecoveredCount: number;
  maxRecoveryMs: number | null; recoveryDistribution: Record<string, number>;
}

// ── Reader real window.LS (vía instancia; NO se copia la lógica de extracción) ──
export interface LsReader { capture: () => Promise<{ variants: unknown[] }>; }

const isValidPrice = (p: unknown): boolean => typeof p === "number" && Number.isFinite(p) && p > 0;

export function classifyError(err: unknown): string {
  const m = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (m.includes("econnreset") || m.includes("connection reset") || m.includes("err_connection_reset")) return "CONNECTION_RESET";
  if (m.includes("timeout") || m.includes("timed out")) return "TIMEOUT";
  if (m.includes("err_connection") || m.includes("net::")) return "NET_ERROR";
  return "OTHER";
}

/** Cuenta variantes/skus/precios a partir del payload real, con los mappers productivos. */
function countPayload(variants: unknown[], ordinal: number): { initial: number; skuCount: number; validPrice: number } {
  const reduced = mapProductPagePayloadToReducedRows({ variants } as any, ordinal, new Date().toISOString());
  const skuCount = reduced.filter((r: any) => typeof r.rawSku === "string" && r.rawSku.trim().length > 0).length;
  const validPrice = reduced.filter((r: any) => isValidPrice(r.priceNumber)).length;
  return { initial: variants.length, skuCount, validPrice };
}

/** Una ficha: navega (domcontentloaded) + lectura INMEDIATA de window.LS (comportamiento worker). */
export async function captureImmediate(
  page: Page, reader: LsReader, url: string, ordinal: number, baseUrl: string,
): Promise<UrlRecord> {
  const t0 = Date.now();
  const rec: UrlRecord = {
    canonicalUrl: url, ordinal, historicalOrdinal: null, navStatus: null, finalUrl: null,
    redirectedToLogin: false, authWitness: false, initialVariantCount: 0, variantSkuCount: 0,
    validPriceVariantCount: 0, firstNonzeroVariantAtMs: null, challengeWitness: false, http429: false,
    retryAfterObserved: false, connectionReset: false, errorClass: null, elapsedMs: 0,
  };
  try {
    const resp = await page.goto(url, { waitUntil: "domcontentloaded" });
    rec.navStatus = resp?.status() ?? null;
    rec.finalUrl = page.url();
    rec.redirectedToLogin = rec.finalUrl.includes("login") || rec.finalUrl === baseUrl;
    if (rec.navStatus === 429) rec.http429 = true;
    if (rec.navStatus === 429 || rec.navStatus === 503) rec.challengeWitness = true;
    const h = resp?.headers?.() ?? {};
    if (h["retry-after"] !== undefined) rec.retryAfterObserved = true;
  } catch (e) {
    rec.errorClass = classifyError(e);
    if (rec.errorClass === "CONNECTION_RESET") rec.connectionReset = true;
    rec.elapsedMs = Date.now() - t0;
    return rec;
  }
  try {
    const payload = await reader.capture();
    const c = countPayload(payload.variants ?? [], ordinal);
    rec.initialVariantCount = c.initial;
    rec.variantSkuCount = c.skuCount;
    rec.validPriceVariantCount = c.validPrice;
    rec.authWitness = c.validPrice > 0; // PRICING_CAPABILITY_WITNESS
  } catch (e) {
    rec.errorClass = classifyError(e);
  }
  rec.elapsedMs = Date.now() - t0;
  return rec;
}

/** Checkpoint de sesión PACIENTE (distinto del brazo): espera a que LS poble, luego mide precio. */
export async function sessionCheckpoint(page: Page, reader: LsReader, probeUrl: string, baseUrl: string): Promise<boolean> {
  try {
    await page.goto(probeUrl, { waitUntil: "domcontentloaded" });
    const finalUrl = page.url();
    if (finalUrl.includes("login") || finalUrl === baseUrl) return false; // redirigido a login → sesión perdida
    await page.waitForFunction(
      `(function(){var LS=(typeof window!=="undefined"&&window.LS)||{};return Array.isArray(LS.variants)&&LS.variants.length>0;})()`,
      { timeout: 5000 },
    ).catch(() => {});
    const payload = await reader.capture();
    const c = countPayload(payload.variants ?? [], -1);
    return c.validPrice > 0; // pricing visible con espera generosa ⇒ sesión válida
  } catch {
    return false;
  }
}

/** Corre un brazo serial sobre la cohorte con delay inter-ficha opcional + checkpoints de sesión. */
export async function runArm(
  page: Page, reader: LsReader,
  cohort: { canonicalUrl: string; historicalOrdinal: number | null }[],
  opts: { interProductDelayMs: number; baseUrl: string; probeUrl: string; checkpointOrdinals: number[]; onProgress?: (i: number, rec: UrlRecord) => void },
): Promise<ArmResult> {
  const records: UrlRecord[] = [];
  const checkpoints: SessionCheckpoint[] = [];
  // checkpoint inicial (before #1)
  checkpoints.push({ ordinalBefore: 0, authWitness: await sessionCheckpoint(page, reader, opts.probeUrl, opts.baseUrl) });
  for (let i = 0; i < cohort.length; i++) {
    if (i > 0 && opts.interProductDelayMs > 0) await page.waitForTimeout(opts.interProductDelayMs);
    const rec = await captureImmediate(page, reader, cohort[i].canonicalUrl, i, opts.baseUrl);
    rec.historicalOrdinal = cohort[i].historicalOrdinal;
    records.push(rec);
    opts.onProgress?.(i, rec);
    if (opts.checkpointOrdinals.includes(i + 1)) {
      checkpoints.push({ ordinalBefore: i + 1, authWitness: await sessionCheckpoint(page, reader, opts.probeUrl, opts.baseUrl) });
    }
  }
  return { records, agg: aggregate(records, checkpoints), checkpoints };
}

/** ZERO-REPLAY: re-lee window.LS del MISMO documento a 250/500/1000/2000/5000ms, SIN reload. */
export async function zeroReplay(
  page: Page, reader: LsReader, zeroUrls: string[], baseUrl: string,
): Promise<{ records: ZeroReplayRecord[]; agg: ZeroReplayAgg }> {
  const records: ZeroReplayRecord[] = [];
  const times = [250, 500, 1000, 2000, 5000] as const;
  for (const url of zeroUrls) {
    const r: ZeroReplayRecord = {
      canonicalUrl: url, initialVariantCount: 0, at250: 0, at500: 0, at1000: 0, at2000: 0, at5000: 0,
      firstNonzeroVariantAtMs: null, authWitnessT0: false, authWitnessFinal: false, finalUrlChanged: false,
    };
    let navOk = true;
    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
    } catch { navOk = false; }
    if (!navOk) { records.push(r); continue; }
    const startUrl = page.url();
    const p0 = await reader.capture().catch(() => ({ variants: [] as unknown[] }));
    r.initialVariantCount = (p0.variants ?? []).length;
    r.authWitnessT0 = countPayload(p0.variants ?? [], -1).validPrice > 0;
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
    r.authWitnessFinal = countPayload(pf.variants ?? [], -1).validPrice > 0;
    r.finalUrlChanged = page.url() !== startUrl;
    if (r.initialVariantCount > 0) r.firstNonzeroVariantAtMs = 0;
    records.push(r);
  }
  const recovered = records.filter((r) => r.initialVariantCount === 0 && r.firstNonzeroVariantAtMs !== null && r.firstNonzeroVariantAtMs !== 0);
  const never = records.filter((r) => r.initialVariantCount === 0 && r.firstNonzeroVariantAtMs === null);
  const dist: Record<string, number> = { "250": 0, "500": 0, "1000": 0, "2000": 0, "5000": 0, NEVER: 0 };
  for (const r of records) {
    if (r.initialVariantCount > 0) continue;
    if (r.firstNonzeroVariantAtMs === null) dist.NEVER++;
    else dist[String(r.firstNonzeroVariantAtMs)]++;
  }
  const maxRecoveryMs = recovered.length ? Math.max(...recovered.map((r) => Number(r.firstNonzeroVariantAtMs))) : null;
  return {
    records,
    agg: { executed: true, urlCount: records.length, recoveredWithoutReloadCount: recovered.length, neverRecoveredCount: never.length, maxRecoveryMs, recoveryDistribution: dist },
  };
}

export function aggregate(records: UrlRecord[], checkpoints: SessionCheckpoint[]): ArmAgg {
  const firstZero = records.find((r) => r.navStatus !== null && r.errorClass === null && r.initialVariantCount === 0);
  const sessionLoss = checkpoints.filter((c) => c.authWitness === false).length;
  return {
    urlCount: records.length,
    navSuccessCount: records.filter((r) => r.errorClass === null && r.navStatus !== null).length,
    initialZeroVariantCount: records.filter((r) => r.errorClass === null && r.initialVariantCount === 0).length,
    nonzeroVariantCount: records.filter((r) => r.initialVariantCount > 0).length,
    variantTotal: records.reduce((a, r) => a + r.initialVariantCount, 0),
    validPriceVariantCount: records.reduce((a, r) => a + r.validPriceVariantCount, 0),
    urlsWithAnyValidPrice: records.filter((r) => r.validPriceVariantCount > 0).length,
    sessionLossCount: sessionLoss,
    http429Count: records.filter((r) => r.http429).length,
    retryAfterCount: records.filter((r) => r.retryAfterObserved).length,
    challengeCount: records.filter((r) => r.challengeWitness).length,
    connectionResetCount: records.filter((r) => r.connectionReset).length,
    firstZeroOrdinal: firstZero ? firstZero.ordinal : null,
  };
}
