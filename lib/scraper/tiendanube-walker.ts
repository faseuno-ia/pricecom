// GATE A2 — walker vivo SKU-first (dos fases) para TiendaNube.
//
// Topología correcta (recuperada de Gate 1C, ver GATE1C-capture-report.md §1/§4):
//   Fase A (discovery): recorrer páginas de LISTADO, extraer URLs de producto,
//     resolver relativas, deduplicar, avanzar SOLO por paginación de listados.
//   Fase B (captura): visitar cada FICHA individual, leer window.LS EN LA FICHA,
//     mapear cada variante a fila reducida; agrupar por sku.trim() al FINAL.
//
// `window.LS.variants` SOLO existe en la ficha individual, no en el listado. Por
// eso el discovery no lee LS y la captura no pagina (`goToNextListing` nunca se
// llama dentro de una ficha).
//
// Toda la I/O (navegación, login, evaluate, logging, cancelación) está inyectada
// vía `WalkerDeps`: el walker es puro y testeable sin red/sitio/Playwright. El
// wiring real (scraper.service) construye las deps a partir de la Page.
//
// ── 2G-R8-Q2 · HTTP 429 REACTIVE RECOVERY ──────────────────────────────────────
// `captureProductRows` es el ÚNICO OWNER de la recuperación reactiva ante HTTP 429
// (single owner, §2). Un 429 dejó de convertirse en "ficha sin variantes"
// (ZERO_VARIANT): ahora se reintenta LA MISMA navegación (byte por byte, §10) con
// delay acotado (§11), respetando Retry-After (§12) y un budget global (§13), y se
// devuelve un OUTCOME EXPLÍCITO por ficha (§3): VERIFIED_OK | DATA_INCOMPLETE |
// RATE_LIMITED | READ_FAILED. NUNCA VERIFIED_ABSENT (§3.1). El contador 429 y el
// budget son de ALCANCE FICHA (no por-attempt), y RATE_LIMITED se DEVUELVE (nunca se
// lanza) y es TERMINAL para la ficha → el loop de reintentos por excepción no puede
// re-disparar otro ciclo de 429 (RETRY_MULTIPLICATION_RISK = false, §2).

import {
  groupSkuFirst,
  mapLsVariantToReducedRow,
  type GroupResult,
  type TnReducedRow,
} from "./tiendanube-sku-first";
import {
  MAX_429_RETRIES,
  WALK_429_SLEEP_BUDGET_MS,
  parseRetryAfterMs,
  compute429Delay,
} from "./http-429-recovery";

/** Payload crudo mínimo (JSON-safe) leído de `window.LS` en una ficha. */
export interface RawLsPagePayload {
  productName: string | null;
  productUrl: string | null;
  domLabels: (string | null)[];
  variants: Record<string, unknown>[];
}

export interface WalkStats {
  listingPagesProcessed: number;
  productsDiscovered: number;
  productsVisited: number;
  productsFailed: number;
  variantsCaptured: number;
}

// ── 2G-R8-Q2 · Modelo de outcome de ficha (Nivel 1, §3.1) ─────────────────────
/** Outcome de CAPTURA de una ficha. NUNCA incluye VERIFIED_ABSENT (§3.1/§5). */
export type FichaCaptureOutcome = "VERIFIED_OK" | "DATA_INCOMPLETE" | "RATE_LIMITED" | "READ_FAILED";

/** Witness independiente de completitud del set de variantes (§3.2). true | false | "unknown". */
export type VariantSetComplete = boolean | "unknown";

export interface FichaCaptureResult {
  outcome: FichaCaptureOutcome;
  /** Filas capturadas (una por variante). Vacío salvo VERIFIED_OK. */
  rows: TnReducedRow[];
  recoveredAfter429: boolean;
  recoveryAttempts: number; // nº de reintentos 429 efectuados en esta ficha (>=0)
  httpStatusFinal: number | null;
  variantSetComplete: VariantSetComplete;
  /** Sleep 429 agregado gastado por esta ficha (para el budget del walk). */
  sleptMs: number;
  /** Nº de requests de documento (page.goto) emitidos — auditoría de multiplicación (§2). */
  documentRequests: number;
}

/** Resultado de navegación de la Fase B (§11 requiere status + Retry-After para el owner 429). */
export interface NavigateResult {
  redirectedToLogin: boolean;
  status: number | null;
  /** Header Retry-After crudo (delta-seconds o HTTP-date), o null si ausente. Nunca otros headers. */
  retryAfter?: string | null;
}

/** Evento de observabilidad 429 (§15). El wiring lo formatea como [SkuFirstRateLimit*]. */
export type RateLimitEventKind = "RATE_LIMIT" | "RECOVERED" | "EXHAUSTED" | "BUDGET_EXHAUSTED";
export interface RateLimitEvent {
  kind: RateLimitEventKind;
  ordinal: number;
  originalNavigationUrl: string;
  attempt: number; // RATE_LIMIT: nº de reintento 1-based; RECOVERED/EXHAUSTED: total de reintentos
  navStatus: number | null;
  retryAfterPresent: boolean;
  retryAfterMs: number | null;
  appliedDelayMs: number | null;
  remainingBudgetMs: number;
  totalDelayMs: number; // sleep 429 acumulado en esta ficha
}

export interface WalkerDeps {
  // ── Fase A ──────────────────────────────────────────────────────────────
  /**
   * Semilla de discovery sitemap-driven (2G-R3). Cuando está presente y no vacía,
   * la Fase A NO recorre listados: usa estas URLs canónicas (típicamente el
   * `startSnapshot.urls` del sitemap START, la misma autoridad de completitud) como
   * conjunto de discovery. Se re-validan/canonicalizan con `resolveUrl` y se deduplican.
   * Motivo: el listado del storefront demostró ser INCOMPLETO (817<877 en DT), mientras
   * el sitemap ya es la autoridad de completitud. Si está ausente/vacía → Fase A legacy.
   */
  seedProductUrls?: string[];
  /** Extrae los href de producto del listado actual (crudos, sin resolver). */
  extractListingProductUrls: () => Promise<string[]>;
  /** Resuelve/valida un href; devolver null descarta la URL. */
  resolveUrl: (href: string) => string | null;
  /** Avanza al siguiente listado. `true` si avanzó, `false` si no hay más. */
  goToNextListing: () => Promise<boolean>;
  maxListingPages: number;

  // ── Fase B ──────────────────────────────────────────────────────────────
  /** Navega a la ficha; informa redirección a login, status HTTP y Retry-After (para el owner 429). */
  navigateToProduct: (url: string) => Promise<NavigateResult>;
  /** Re-autentica reutilizando el login existente. */
  reLogin: () => Promise<void>;
  /** Lee window.LS de la ficha actual. Lanza ante fallo transitorio. */
  captureLsPayload: () => Promise<RawLsPagePayload>;
  maxProductRetries: number;

  // ── 2G-R8-Q2 · recuperación 429 (inyectable; defaults inertes para tests puros) ──
  /** Espera real. Default: setTimeout. Los tests inyectan un fake que registra sin dormir. */
  sleep?: (ms: number) => Promise<void>;
  /** Hook de observabilidad 429 (§15). Inerte si ausente. NUNCA rompe la captura. */
  onRateLimit?: (ev: RateLimitEvent) => Promise<void> | void;

  // ── Transversal ─────────────────────────────────────────────────────────
  now: () => string;
  isCancelled: () => boolean;
  onLog: (level: "DEBUG" | "INFO" | "WARN" | "ERROR", msg: string) => Promise<void>;
  onProgress: (stats: WalkStats) => Promise<void>;

  // ── 2G-R7 · Observabilidad (OPCIONAL, inerte si ausente) ──────────────────
  /** Reloj en ms para medir el costo por ficha y parsear Retry-After HTTP-date. Default Date.now. */
  nowMs?: () => number;
  /** Hook por ficha (post-captura). No altera el resultado de captureProductRows. */
  onProductObserved?: (obs: WalkerProductObservation) => void | Promise<void>;
}

/** Observación por ficha del walk productivo (§14: taxonomía 429-aware). */
export interface WalkerProductObservation {
  ordinal: number;
  url: string;
  elapsedMs: number;
  outcome: FichaCaptureOutcome;
  variantsCaptured: number;
  recoveredAfter429: boolean;
  recoveryAttempts: number;
  httpStatusFinal: number | null;
  variantSetComplete: VariantSetComplete;
}

/** Contexto de budget 429 de ALCANCE WALK (mutable), pasado a cada captureProductRows. */
export interface RateLimitWalkBudget {
  remainingMs: number;
  totalSleptMs: number;
}

/** Fase A: recolecta URLs de producto de los listados, deduplicadas y ordenadas. */
export async function collectProductUrlsFromListings(
  deps: WalkerDeps,
): Promise<{ urls: string[]; listingPages: number }> {
  const seen = new Set<string>();
  const urls: string[] = [];
  let listingPages = 0;

  while (listingPages < deps.maxListingPages) {
    if (deps.isCancelled()) break;
    listingPages++;
    const rawHrefs = await deps.extractListingProductUrls();
    for (const href of rawHrefs) {
      const resolved = deps.resolveUrl(href);
      if (!resolved) continue;
      if (seen.has(resolved)) continue;
      seen.add(resolved);
      urls.push(resolved);
    }
    if (deps.isCancelled()) break;
    const advanced = await deps.goToNextListing();
    if (!advanced) break;
  }
  return { urls, listingPages };
}

/**
 * Fase A sitemap-driven (2G-R3): canonicaliza/valida/deduplica el seed sin recorrer
 * listados. Reusa `resolveUrl` (mismo predicado de producto + canonicalización que la
 * Fase A de listados) para que una URL basura del sitemap no entre al discovery. NO
 * garantiza captura: cada URL entra recién al ACCEPTED_WALK_SET si la Fase B la acepta.
 */
export function collectProductUrlsFromSeed(
  seed: string[],
  deps: WalkerDeps,
): { urls: string[]; rejected: number; duplicates: number } {
  const seen = new Set<string>();
  const urls: string[] = [];
  let rejected = 0;
  let duplicates = 0;
  for (const href of seed) {
    const resolved = deps.resolveUrl(href);
    if (!resolved) { rejected++; continue; }
    if (seen.has(resolved)) { duplicates++; continue; }
    seen.add(resolved);
    urls.push(resolved);
  }
  return { urls, rejected, duplicates };
}

/** Mapea el payload de una ficha a filas reducidas (una por variante). */
export function mapProductPagePayloadToReducedRows(
  payload: RawLsPagePayload | null,
  sourcePageIndex: number,
  capturedAt: string,
): TnReducedRow[] {
  if (!payload || !Array.isArray(payload.variants) || payload.variants.length === 0) return [];
  const fallbackProductId = (payload.variants[0]?.product_id as unknown) ?? null;
  return payload.variants.map(
    (rawVariant, sourceVariantIndex) =>
      mapLsVariantToReducedRow(rawVariant, {
        sourcePageIndex,
        sourceVariantIndex,
        productId: (rawVariant.product_id as unknown) ?? fallbackProductId,
        productName: payload.productName,
        productUrl: payload.productUrl,
        domLabels: payload.domLabels ?? [],
        capturedAt,
      }) as unknown as TnReducedRow,
  );
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Fase B (una ficha): navega, maneja redirección a login + re-login, RECUPERA HTTP 429
 * de forma reactiva y acotada (§11), captura window.LS y mapea. Devuelve un
 * `FichaCaptureResult` con outcome explícito (§3). NUNCA pagina.
 *
 * Invariantes de no-multiplicación (§2):
 *  - `retries429` y `remaining` (budget) son de ALCANCE FICHA: viven fuera del loop de
 *    reintentos por excepción, así un re-drive por excepción no reinicia el budget 429.
 *  - RATE_LIMITED se DEVUELVE (nunca se lanza) y es TERMINAL: el loop externo no lo re-dispara.
 *  - Un 429 puro (sin excepción) hace exactamente ≤ 1 + MAX_429_RETRIES = 4 requests de documento.
 *
 * §10: el reintento navega SIEMPRE `url` (la cadena exacta que recibió el walker), nunca la
 * canónica ni la post-redirect.
 */
export async function captureProductRows(
  url: string,
  sourcePageIndex: number,
  deps: WalkerDeps,
  ctx?: { rateLimitBudget?: RateLimitWalkBudget },
): Promise<FichaCaptureResult> {
  const sleep = deps.sleep ?? defaultSleep;
  const nowMs = deps.nowMs ?? (() => Date.now());
  const budget = ctx?.rateLimitBudget;

  // Alcance FICHA (persisten a través de los reintentos por excepción del loop externo).
  let retries429 = 0;
  let sleptMs = 0;
  let documentRequests = 0;
  let recovered = false;
  let statusFinal: number | null = null;
  const remainingAtStart = budget ? budget.remainingMs : WALK_429_SLEEP_BUDGET_MS;
  let remaining = remainingAtStart;

  const emit = async (ev: RateLimitEvent) => {
    if (!deps.onRateLimit) return;
    try { await deps.onRateLimit(ev); } catch { /* la observabilidad NUNCA rompe la captura */ }
  };
  const commitSleep = (ms: number) => {
    sleptMs += ms;
    remaining -= ms;
    if (budget) { budget.remainingMs -= ms; budget.totalSleptMs += ms; }
  };
  const result = (outcome: FichaCaptureOutcome, rows: TnReducedRow[], variantSetComplete: VariantSetComplete): FichaCaptureResult => ({
    outcome, rows, recoveredAfter429: recovered, recoveryAttempts: retries429,
    httpStatusFinal: statusFinal, variantSetComplete, sleptMs, documentRequests,
  });

  for (let attempt = 0; attempt <= deps.maxProductRetries; attempt++) {
    try {
      let nav = await deps.navigateToProduct(url);
      documentRequests++;
      statusFinal = nav.status;
      if (nav.redirectedToLogin) {
        await deps.reLogin();
        nav = await deps.navigateToProduct(url);
        documentRequests++;
        statusFinal = nav.status;
      }

      // ── Owner 429 (single owner, §11-§13) ──────────────────────────────
      while (nav.status === 429 && retries429 < MAX_429_RETRIES) {
        const retryAfterMs = parseRetryAfterMs(nav.retryAfter ?? null, nowMs());
        const decision = compute429Delay({ attempt: retries429 + 1, retryAfterMs, remainingBudgetMs: remaining });
        await emit({
          kind: "RATE_LIMIT", ordinal: sourcePageIndex, originalNavigationUrl: url,
          attempt: retries429 + 1, navStatus: 429, retryAfterPresent: decision.retryAfterPresent,
          retryAfterMs, appliedDelayMs: decision.appliedDelayMs, remainingBudgetMs: remaining, totalDelayMs: sleptMs,
        });
        if (decision.exceedsBudget) {
          await emit({
            kind: "BUDGET_EXHAUSTED", ordinal: sourcePageIndex, originalNavigationUrl: url,
            attempt: retries429, navStatus: 429, retryAfterPresent: decision.retryAfterPresent,
            retryAfterMs, appliedDelayMs: null, remainingBudgetMs: remaining, totalDelayMs: sleptMs,
          });
          return result("RATE_LIMITED", [], "unknown");
        }
        await sleep(decision.appliedDelayMs);
        commitSleep(decision.appliedDelayMs);
        retries429++;
        nav = await deps.navigateToProduct(url); // §10: MISMA url, byte por byte
        documentRequests++;
        statusFinal = nav.status;
        if (nav.status !== 429 && nav.redirectedToLogin) {
          await deps.reLogin();
          nav = await deps.navigateToProduct(url);
          documentRequests++;
          statusFinal = nav.status;
        }
      }

      if (nav.status === 429) {
        // Agotó MAX_429_RETRIES y sigue 429.
        await emit({
          kind: "EXHAUSTED", ordinal: sourcePageIndex, originalNavigationUrl: url,
          attempt: retries429, navStatus: 429, retryAfterPresent: false,
          retryAfterMs: null, appliedDelayMs: null, remainingBudgetMs: remaining, totalDelayMs: sleptMs,
        });
        return result("RATE_LIMITED", [], "unknown");
      }
      if (retries429 > 0) {
        recovered = true;
        await emit({
          kind: "RECOVERED", ordinal: sourcePageIndex, originalNavigationUrl: url,
          attempt: retries429, navStatus: nav.status, retryAfterPresent: false,
          retryAfterMs: null, appliedDelayMs: null, remainingBudgetMs: remaining, totalDelayMs: sleptMs,
        });
      }

      const payload = await deps.captureLsPayload();
      const rows = mapProductPagePayloadToReducedRows(payload, sourcePageIndex, deps.now());
      if (rows.length === 0) {
        // §3.3 DATA_INCOMPLETE: respuesta utilizable pero sin set de variantes interpretable.
        // NO es RATE_LIMITED (el status ya no es 429) ni ausencia de producto (§5).
        await deps.onLog("WARN", `Ficha sin set de variantes interpretable (DATA_INCOMPLETE), se omite`);
        return result("DATA_INCOMPLETE", [], "unknown");
      }
      // VERIFIED_OK. §3.2: una captura perturbada por rate-limiting NO autoriza a afirmar
      // completitud del set (posición conservadora, NO_ABSENCE_FROM_FAILURE) → "unknown".
      const variantSetComplete: VariantSetComplete = recovered ? "unknown" : true;
      return result("VERIFIED_OK", rows, variantSetComplete);
    } catch {
      // Excepción técnica de navegación/captura (timeout/red/evaluate) → READ_FAILED (§3.5).
      if (attempt === deps.maxProductRetries) {
        await deps.onLog("WARN", `Ficha falló definitivamente (READ_FAILED) tras ${attempt + 1} intento(s), se omite y continúa`);
        return result("READ_FAILED", [], "unknown");
      }
      await deps.onLog("DEBUG", `Reintentando ficha (intento ${attempt + 2})`);
    }
  }
  // Inalcanzable (el loop siempre retorna dentro de try/catch); defensivo.
  return result("READ_FAILED", [], "unknown");
}

/** Resumen de outcomes del walk (§26 · insumos para observabilidad y Q2.1). */
export interface WalkOutcomeSummary {
  verifiedOk: number;
  dataIncomplete: number;
  rateLimited: number;
  readFailed: number;
  recoveredAfter429: number;
  total429SleepMs: number;
}

/**
 * 2G-R8-Q2.1-A-R1 · §3.1 — metadata de cuarentena POR FICHA (count + reasons), derivada
 * DESPUÉS de la agrupación a partir de `grouped.quarantine` + `allRows`. Es SÓLO metadata:
 * no altera productos, cuarentena, navegación, captura, completitud ni persistencia. Q2.1-B la
 * usa para derivar FICHA_SKU_IDENTITY_SET_COMPLETE (una ficha con quarantineCount>0 no autoriza
 * inferir ausencia de variante, por CUALQUIER reason que retire una variante del set reconciliable).
 */
export interface FichaQuarantineInfo {
  count: number;
  reasons: string[];
}

/** Orquesta las dos fases y agrupa por SKU al final. */
export async function runSkuFirstWalk(
  deps: WalkerDeps,
): Promise<GroupResult & { stats: WalkStats; outcomeSummary: WalkOutcomeSummary; fichaToSkus: Record<string, string[]>; fichaQuarantine: Record<string, FichaQuarantineInfo> }> {
  // Fase A. Sitemap-driven (2G-R3) cuando hay seed: NO recorre listados (el listado del
  // storefront es incompleto); usa el START_SET como conjunto de discovery. Sin seed →
  // discovery legacy por listados. En AMBOS casos el ACCEPTED_WALK_SET (autoridad de
  // completitud) se llena SOLO con capturas aceptadas en Fase B, nunca con el seed.
  let urls: string[];
  let listingPages: number;
  if (deps.seedProductUrls && deps.seedProductUrls.length > 0) {
    await deps.onLog("INFO", "[SKU-first] Fase A: discovery desde sitemap START_SET");
    const seeded = collectProductUrlsFromSeed(deps.seedProductUrls, deps);
    urls = seeded.urls;
    listingPages = 0;
    await deps.onLog(
      "INFO",
      `[SKU-first] Fase A: ${urls.length} URLs canónicas sembradas desde sitemap ` +
        `(raw=${deps.seedProductUrls.length}, rechazadas=${seeded.rejected}, duplicadas=${seeded.duplicates})`,
    );
  } else {
    await deps.onLog("INFO", "[SKU-first] Fase A: discovery de URLs de producto en listados");
    const collected = await collectProductUrlsFromListings(deps);
    urls = collected.urls;
    listingPages = collected.listingPages;
    await deps.onLog("INFO", `[SKU-first] Fase A: ${urls.length} URLs únicas en ${listingPages} listados`);
  }

  const stats: WalkStats = {
    listingPagesProcessed: listingPages,
    productsDiscovered: urls.length,
    productsVisited: 0,
    productsFailed: 0,
    variantsCaptured: 0,
  };

  const outcomeSummary: WalkOutcomeSummary = {
    verifiedOk: 0, dataIncomplete: 0, rateLimited: 0, readFailed: 0, recoveredAfter429: 0, total429SleepMs: 0,
  };
  // §9 · FICHA_TO_SKUS_MAP desde capturas VERIFIED_OK: identidad de ficha (productUrl de la
  // ficha o, si falta, la url navegada) → set de SKUs trim observados. Insumo para Q2.1.
  const fichaToSkus = new Map<string, Set<string>>();

  // §13 · budget 429 de alcance WALK (compartido entre fichas).
  const rateLimitBudget: RateLimitWalkBudget = { remainingMs: WALK_429_SLEEP_BUDGET_MS, totalSleptMs: 0 };

  const allRows: TnReducedRow[] = [];
  await deps.onLog("INFO", "[SKU-first] Fase B: captura de fichas individuales");
  for (let i = 0; i < urls.length; i++) {
    if (deps.isCancelled()) {
      await deps.onLog("INFO", "[SKU-first] Cancelado durante captura de fichas");
      break;
    }
    const nowMs = deps.nowMs ?? (() => Date.now());
    const t0 = nowMs();
    const res = await captureProductRows(urls[i], i, deps, { rateLimitBudget });
    const elapsedMs = nowMs() - t0;
    stats.productsVisited++;

    switch (res.outcome) {
      case "VERIFIED_OK": outcomeSummary.verifiedOk++; break;
      case "DATA_INCOMPLETE": outcomeSummary.dataIncomplete++; break;
      case "RATE_LIMITED": outcomeSummary.rateLimited++; break;
      case "READ_FAILED": outcomeSummary.readFailed++; stats.productsFailed++; break;
    }
    if (res.recoveredAfter429) outcomeSummary.recoveredAfter429++;

    if (res.outcome === "VERIFIED_OK" && res.rows.length > 0) {
      allRows.push(...res.rows);
      stats.variantsCaptured += res.rows.length;
      // Identidad de ficha: productUrl de la ficha capturada; fallback a la url navegada.
      const fichaKey = (res.rows[0]?.productUrl as string | null) ?? urls[i];
      if (!fichaToSkus.has(fichaKey)) fichaToSkus.set(fichaKey, new Set());
      const set = fichaToSkus.get(fichaKey)!;
      for (const r of res.rows) {
        const sku = r.rawSku == null ? "" : String(r.rawSku).trim();
        if (sku !== "") set.add(sku);
      }
    }

    // 2G-R7/Q2 · hook de observabilidad (inerte si ausente; NO altera el resultado de la captura).
    if (deps.onProductObserved) {
      await deps.onProductObserved({
        ordinal: i, url: urls[i], elapsedMs, outcome: res.outcome, variantsCaptured: res.rows.length,
        recoveredAfter429: res.recoveredAfter429, recoveryAttempts: res.recoveryAttempts,
        httpStatusFinal: res.httpStatusFinal, variantSetComplete: res.variantSetComplete,
      });
    }
    await deps.onProgress({ ...stats });
  }
  outcomeSummary.total429SleepMs = rateLimitBudget.totalSleptMs;

  const grouped = groupSkuFirst(allRows);
  await deps.onLog(
    "INFO",
    `[SKU-first] Agrupación final: ${grouped.products.length} productos, ` +
      `${grouped.quarantine.length} en cuarentena, ${grouped.diagnostics.variantsPreserved} variantes preservadas`,
  );
  // §16 · insumo para Q2.1: identidades de cuarentena BOUNDED (≤20) y secret-free. Permite resolver
  // QUARANTINE_IDENTITIES_RESOLVED y comparar identidades entre corridas (no sólo el count). La unidad
  // NO es FICHA: MISSING_SKU es de VARIANTE (fila reducida) y NO_USABLE_NAME es de GRUPO-SKU.
  try {
    const qByReason: Record<string, number> = {};
    for (const q of grouped.quarantine) qByReason[q.reason] = (qByReason[q.reason] ?? 0) + 1;
    const sample = grouped.quarantine.slice(0, 20).map((q) => ({ reason: q.reason, trimmedSku: q.trimmedSku, productId: q.productId, variantId: q.variantId }));
    await deps.onLog("INFO", `[SkuFirstQuarantine] ${JSON.stringify({ count: grouped.quarantine.length, byReason: qByReason, unit: "VARIANT_OR_SKU_GROUP_NOT_FICHA", sample })}`);
  } catch { /* la telemetría NUNCA rompe el walk */ }
  const fichaToSkusObj: Record<string, string[]> = {};
  for (const [k, v] of fichaToSkus) fichaToSkusObj[k] = [...v].sort();

  // §3.1 · metadata de cuarentena por ficha (derivada de grouped.quarantine + allRows). SÓLO
  // metadata: NO altera grouped.products/grouped.quarantine ni decisión alguna del walk. Cada
  // entrada de cuarentena mapea a su ficha vía allRows[originalCaptureIndex].productUrl.
  const fichaQuarantine: Record<string, FichaQuarantineInfo> = {};
  for (const q of grouped.quarantine) {
    const row = allRows[q.originalCaptureIndex];
    const ficha = (row?.productUrl as string | null) ?? null;
    const key = ficha ?? `__no_ficha__:${q.originalCaptureIndex}`;
    if (!fichaQuarantine[key]) fichaQuarantine[key] = { count: 0, reasons: [] };
    fichaQuarantine[key].count++;
    fichaQuarantine[key].reasons.push(q.reason);
  }

  return { ...grouped, stats, outcomeSummary, fichaToSkus: fichaToSkusObj, fichaQuarantine };
}
