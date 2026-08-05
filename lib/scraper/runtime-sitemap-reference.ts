// G1 — Referencia de sitemap en RUNTIME para el camino SKU-first de Different Touch.
//
// PURO salvo por `fetchFn` inyectado (HTTP). Sin artifacts, sin .env, sin DB, sin
// browser/Playwright, sin robots discovery, sin fallback al CDN. Entrypoint FIJO
// on-domain (confirmado por SM0). No sigue sitemapindex. Fail-closed ante cualquier
// ambigüedad. Normaliza con la primitiva firmada `normalizeCatalogUrl`.
import { normalizeCatalogUrl } from "./url-normalization";

/** Entrypoint on-domain confirmado por SM0 (NO el sitemap del CDN cross-domain). */
export const DIFFERENTTOUCH_SITEMAP_ENTRYPOINT = "https://differenttouch.com.ar/sitemap.xml";

const ALLOWED_HOSTS = new Set(["differenttouch.com.ar", "www.differenttouch.com.ar"]);
const PRODUCT_PATH_PREFIX = "/productos/";

export type SitemapFetchFailReason =
  | "NETWORK_ERROR"
  | "HTTP_INVALID"
  | "XML_INVALID"
  | "UNSUPPORTED_SITEMAPINDEX"
  | "REDIRECT_UNSUPPORTED"
  | "CROSS_DOMAIN_RESPONSE"
  | "PRODUCT_PREDICATE_INVALID"
  | "NORMALIZATION_FAILURE"
  | "HTTP_429_NO_RETRY";

export type SitemapSnapshot =
  | { kind: "POPULATED"; urls: string[]; rawLocCount: number; productLocCount: number }
  | { kind: "EXPLICITLY_EMPTY"; rawLocCount: number; productLocCount: number }
  | { kind: "FETCH_FAILED"; reason: SitemapFetchFailReason };

/** Respuesta HTTP mínima (inyectable). `header` es case-insensitive por contrato. */
export interface HttpResponseLike {
  status: number;
  text: string;
  finalUrl: string;
  header: (name: string) => string | null;
}
export type SitemapFetchFn = (url: string) => Promise<HttpResponseLike>;

export interface FetchSitemapOptions {
  fetchFn: SitemapFetchFn;
  /** Solo para tests; en producción se usa el entrypoint fijo on-domain. */
  entryPoint?: string;
  sleepFn?: (ms: number) => Promise<void>;
  nowMs?: () => number;
}

/**
 * Predicado de ficha de producto derivado y probado en SM0:
 *   host ∈ {differenttouch.com.ar, www.differenttouch.com.ar}
 *   AND pathname empieza con "/productos/"
 *   AND slug no vacío después de "/productos/"   (excluye "/productos" y "/productos/")
 * Puro y determinístico: nunca lanza (URL inválida → false).
 */
export function isProductDetailUrl(rawLoc: string): boolean {
  let u: URL;
  try {
    u = new URL(rawLoc);
  } catch {
    return false;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return false;
  if (!ALLOWED_HOSTS.has(u.host.toLowerCase())) return false;
  if (!u.pathname.startsWith(PRODUCT_PATH_PREFIX)) return false;
  const slug = u.pathname.slice(PRODUCT_PATH_PREFIX.length).replace(/\/+$/, "");
  return slug.length > 0;
}

function finalUrlAllowed(finalUrl: string): boolean {
  try {
    const u = new URL(finalUrl);
    return u.protocol === "https:" && ALLOWED_HOSTS.has(u.host.toLowerCase());
  } catch {
    return false;
  }
}

/** Retry-After (delta-seconds o HTTP-date) → ms, o null si inválido. */
export function parseRetryAfterMs(value: string | null, nowMs: number): number | null {
  if (value == null) return null;
  const t = value.trim();
  if (t === "") return null;
  if (/^\d+$/.test(t)) return parseInt(t, 10) * 1000;
  const d = Date.parse(t);
  if (!Number.isNaN(d)) return d - nowMs;
  return null;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0*39;/g, "'").replace(/&apos;/g, "'");
}

type PolicyResult =
  | { ok: true; res: HttpResponseLike }
  | { ok: false; reason: SitemapFetchFailReason };

/**
 * Política E2: máx 2 intentos por snapshot (1 inicial + 1 retry).
 *   retry (backoff 500ms) SOLO ante: network error · 408 · 5xx.
 *   429: retry único SOLO si Retry-After válido y 0 < delay ≤ 10000ms; si no → fail-closed.
 *   otros 4xx / XML no chequeado acá → sin retry.
 *   3xx → REDIRECT_UNSUPPORTED (sin seguir Location, sin retry).
 *   finalUrl fuera del dominio permitido (cualquier status) → CROSS_DOMAIN_RESPONSE (GUARD_2,
 *     independiente de la política de redirect del adapter).
 */
async function fetchWithPolicy(
  url: string,
  fetchFn: SitemapFetchFn,
  sleepFn: (ms: number) => Promise<void>,
  nowMs: () => number,
): Promise<PolicyResult> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    let res: HttpResponseLike;
    try {
      res = await fetchFn(url);
    } catch {
      if (attempt === 1) { await sleepFn(500); continue; }
      return { ok: false, reason: "NETWORK_ERROR" };
    }
    const s = res.status;
    // Precedencia: 3xx (redirect no seguido) antes que la validación de host.
    if (s >= 300 && s < 400) return { ok: false, reason: "REDIRECT_UNSUPPORTED" };
    // GUARD_2: el módulo valida el host de la respuesta por sí mismo, aunque el status sea 200.
    // No confía en que el adapter haya usado redirect:"manual".
    if (!finalUrlAllowed(res.finalUrl)) return { ok: false, reason: "CROSS_DOMAIN_RESPONSE" };
    if (s >= 200 && s < 300) return { ok: true, res };
    if (s === 408 || (s >= 500 && s <= 599)) {
      if (attempt === 1) { await sleepFn(500); continue; }
      return { ok: false, reason: "HTTP_INVALID" };
    }
    if (s === 429) {
      const delay = parseRetryAfterMs(res.header("retry-after"), nowMs());
      if (attempt === 1 && delay !== null && delay > 0 && delay <= 10000) { await sleepFn(delay); continue; }
      return { ok: false, reason: "HTTP_429_NO_RETRY" };
    }
    return { ok: false, reason: "HTTP_INVALID" };
  }
  /* c8 ignore next */ return { ok: false, reason: "HTTP_INVALID" };
}

/**
 * Obtiene un snapshot de la referencia de sitemap. Devuelve un estado tipado:
 *   POPULATED · EXPLICITLY_EMPTY · FETCH_FAILED. NUNCA lanza (fail-closed vía estado).
 */
export async function fetchSitemapSnapshot(opts: FetchSitemapOptions): Promise<SitemapSnapshot> {
  const entry = opts.entryPoint ?? DIFFERENTTOUCH_SITEMAP_ENTRYPOINT;
  const sleep = opts.sleepFn ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const nowMs = opts.nowMs ?? (() => Date.now());

  const fetched = await fetchWithPolicy(entry, opts.fetchFn, sleep, nowMs);
  if (!fetched.ok) return { kind: "FETCH_FAILED", reason: fetched.reason };

  const xml = fetched.res.text;
  if (/<sitemapindex[\s>]/i.test(xml)) return { kind: "FETCH_FAILED", reason: "UNSUPPORTED_SITEMAPINDEX" };
  if (!/<urlset[\s>]/i.test(xml)) return { kind: "FETCH_FAILED", reason: "XML_INVALID" };

  const rawLocs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => decodeXmlEntities(m[1].trim()));
  const productLocs = rawLocs.filter(isProductDetailUrl);

  const normalized: string[] = [];
  for (const loc of productLocs) {
    const n = normalizeCatalogUrl(loc);
    if (n === null) return { kind: "FETCH_FAILED", reason: "NORMALIZATION_FAILURE" };
    normalized.push(n);
  }
  const unique = [...new Set(normalized)];
  if (unique.length === 0) {
    return { kind: "EXPLICITLY_EMPTY", rawLocCount: rawLocs.length, productLocCount: productLocs.length };
  }
  return { kind: "POPULATED", urls: unique, rawLocCount: rawLocs.length, productLocCount: productLocs.length };
}
