// A3-P1 — Builder PURO de la configuración efectiva de runtime del provider.
//
// Determinístico y sin efectos: sin DB, sin `process.env`, sin credenciales, sin browser,
// sin red, sin I/O, sin mutar el input. No importa el Prisma Client en runtime (el input
// es un shape estructural mínimo, testeable sin DB).
//
// Autoridad de `extractionMode`: se IMPORTA y EJECUTA `resolveExtractionMode` in-situ
// (lib/scraper/tiendanube-sku-first.ts). NO se reimplementa su validación ni se captura su
// throw (DUPLICATE_EXTRACTION_MODE_VALIDATION_IN_BUILDER = PROHIBITED).
//
// Límite P1: los campos de login se resuelven, validan y aterrizan en la config efectiva,
// pero NO llegan todavía al ejecutor de login en vivo (BUILDER_LEVEL_ONLY; consumo diferido
// a P2/P3).

import { resolveExtractionMode, type ExtractionMode } from "./tiendanube-sku-first";

export type LoginFlowStrategy = "LEGACY" | "DOCUMENT_REDIRECT";

/**
 * Contrato de path de login CONGELADO para Different Touch. NO es un validador genérico:
 * el ingreso futuro de un provider con otro path de login es una decisión de diseño explícita.
 *   LOGIN_URL_PATH_FROZEN_FOR_DIFFERENTTOUCH = true
 */
export const DIFFERENTTOUCH_LOGIN_PATH = "/account/login/";

/** Shape estructural mínimo (Prisma-compatible) — no importa el Prisma Client. */
export interface ProviderRuntimeConfigInput {
  provider: { baseUrl: string };
  scraperConfig:
    | {
        extractionMode?: string | null;
        loginUrl?: string | null;
        loginFlowStrategy?: string | null;
      }
    | null
    | undefined;
}

export interface ProviderRuntimeConfig {
  effectiveExtractionMode: ExtractionMode;
  effectiveLoginFlowStrategy: LoginFlowStrategy;
  /** URL de login validada, o `null` si no está configurada (login legacy). */
  effectiveLoginUrl: string | null;
}

function isBlankString(v: unknown): boolean {
  return v === null || v === undefined || (typeof v === "string" && v.trim() === "");
}

/**
 * Resuelve `loginFlowStrategy` fail-loud.
 *   null | undefined | "" | solo-whitespace → LEGACY (sin throw).
 *   "LEGACY" | "DOCUMENT_REDIRECT"           → ese valor.
 *   cualquier otro valor no vacío (o no-string) → throw (field + valor).
 */
export function resolveLoginFlowStrategy(value: unknown): LoginFlowStrategy {
  if (value === null || value === undefined) return "LEGACY";
  if (typeof value === "string") {
    if (value.trim() === "") return "LEGACY";
    if (value === "LEGACY" || value === "DOCUMENT_REDIRECT") return value;
  }
  throw new Error(
    `loginFlowStrategy inválido: field=loginFlowStrategy valor recibido=${JSON.stringify(value)}`
  );
}

/**
 * Resuelve/valida `loginUrl` con la clase estándar `URL` (nunca includes/startsWith/regex).
 *   ausente/blank + flow !== DOCUMENT_REDIRECT → null (no configurada; válido para legacy).
 *   ausente/blank + flow === DOCUMENT_REDIRECT → throw (invariante cruzada).
 *   presente → debe cumplir TODO: https, host === host(baseUrl) (incluye puerto),
 *     pathname === "/account/login/", sin query, sin hash, sin user:pass. Si no → throw.
 * Los mensajes nombran `field` y la clase de violación; nunca incluyen credenciales.
 */
export function resolveLoginUrl(
  value: unknown,
  baseUrl: string,
  flow: LoginFlowStrategy
): string | null {
  if (isBlankString(value)) {
    if (flow === "DOCUMENT_REDIRECT") {
      throw new Error(
        "config inválida: field=loginFlowStrategy=DOCUMENT_REDIRECT requiere field=loginUrl (ausente/blank)"
      );
    }
    return null;
  }
  if (typeof value !== "string") {
    throw new Error(`loginUrl inválido: field=loginUrl clase=no-string`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`loginUrl inválido: field=loginUrl clase=URL-invalida`);
  }
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new Error(`loginUrl inválido: field=loginUrl clase=baseUrl-invalida`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`loginUrl inválido: field=loginUrl clase=protocolo-no-https (${url.protocol})`);
  }
  if (url.host !== base.host) {
    // url.host incluye el puerto: un puerto distinto altera el host y cae acá.
    throw new Error(`loginUrl inválido: field=loginUrl clase=host-mismatch (${url.host} != ${base.host})`);
  }
  if (url.pathname !== DIFFERENTTOUCH_LOGIN_PATH) {
    throw new Error(`loginUrl inválido: field=loginUrl clase=pathname (${url.pathname} != ${DIFFERENTTOUCH_LOGIN_PATH})`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`loginUrl inválido: field=loginUrl clase=credenciales-embebidas`);
  }
  if (url.search !== "") {
    throw new Error(`loginUrl inválido: field=loginUrl clase=query-presente`);
  }
  if (url.hash !== "") {
    throw new Error(`loginUrl inválido: field=loginUrl clase=hash-presente`);
  }
  return url.toString();
}

/**
 * Builder puro: Prisma-shaped provider + scraperConfig → config efectiva tipada.
 * Aplica la autoridad in-situ de extractionMode y la invariante cruzada de login.
 */
export function buildProviderRuntimeConfig(input: ProviderRuntimeConfigInput): ProviderRuntimeConfig {
  const cfg = input.scraperConfig ?? null;

  // Autoridad in-situ (su throw en un extractionMode inválido NO se captura acá).
  const effectiveExtractionMode = resolveExtractionMode(cfg?.extractionMode).mode;
  const effectiveLoginFlowStrategy = resolveLoginFlowStrategy(cfg?.loginFlowStrategy);
  const effectiveLoginUrl = resolveLoginUrl(
    cfg?.loginUrl,
    input.provider.baseUrl,
    effectiveLoginFlowStrategy
  );

  return { effectiveExtractionMode, effectiveLoginFlowStrategy, effectiveLoginUrl };
}
