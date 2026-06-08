// Error estructurado de WooCommerce + clasificación (1A.1 — base técnica del
// contrato honesto de sincronización, ver docs/1a-honest-sync-contract.md §7.1).
//
// Hoy client.ts lanza `Error` plano con el status embebido en un string
// ("WooCommerce update error: HTTP 404 ..."), perdiendo status/code/body
// estructurados. Sin eso, la taxonomía recuperable/terminal/ambiguo no se puede
// implementar. WooApiError preserva esa información.
//
// ALCANCE 1A.1 (aditivo puro): este módulo SOLO define el error y la función
// pura de clasificación. `classifyWooError` NO está cableado a ningún
// comportamiento (no decide syncStatus/pendingSync). Ese cableado, el ajuste de
// `pp.status="ERROR"` y la migración de los demás surfaces de catch
// (publication-service.ts, app/api/catalog/publications/[id]/sku/route.ts) son
// 1A.2. WooApiError extiende Error y preserva el `message` original, así que los
// consumidores actuales (que guardan `err.message` en syncError) no cambian.

/** Origen del error. "http" = respuesta no-OK de Woo; el resto = transporte. */
export type WooErrorKind =
  | "http"
  | "timeout"
  | "network"
  | "abort"
  | "parse"
  | "unknown";

/** Clase del error para la taxonomía del contrato honesto. */
export type WooErrorClass =
  | "recoverable"
  | "terminal"
  | "ambiguous"
  | "unknown";

interface WooApiErrorParams {
  message: string;
  kind: WooErrorKind;
  op: string;
  status?: number | null;
  code?: string | null;
  body?: string | null;
}

export class WooApiError extends Error {
  /** Brand para identificar la instancia incluso si cambia el prototype. */
  readonly isWooApiError = true as const;
  /** HTTP status de Woo; null si el error no fue HTTP (timeout/red/etc.). */
  readonly status: number | null;
  /** Código de la WC REST API (p. ej. "product_invalid_sku"); null si no hay. */
  readonly code: string | null;
  /** Body crudo de la respuesta (truncado); null para errores de transporte. */
  readonly body: string | null;
  readonly kind: WooErrorKind;
  /** Operación que falló: "create" | "update" | "status" | "get" | ... */
  readonly op: string;

  constructor(params: WooApiErrorParams) {
    super(params.message);
    this.name = "WooApiError";
    this.kind = params.kind;
    this.op = params.op;
    this.status = params.status ?? null;
    this.code = params.code ?? null;
    this.body = params.body ?? null;
  }

  /**
   * Construye desde una `Response` no-OK de Woo. Lee el body, intenta parsearlo
   * como JSON ({ code, message, data: { status } }) para extraer el `code`, y
   * preserva EXACTAMENTE el formato de message que hoy usa client.ts para no
   * cambiar los strings que se guardan en syncError.
   */
  static async fromResponse(res: Response, op: string): Promise<WooApiError> {
    const body = await res.text().catch(() => "");
    let code: string | null = null;
    try {
      const json = JSON.parse(body);
      if (json && typeof json.code === "string") code = json.code;
    } catch {
      // body no-JSON (HTML de error de hosting, vacío, etc.) — code queda null.
    }
    return new WooApiError({
      message: `WooCommerce ${op} error: HTTP ${res.status} ${body.slice(0, 200)}`,
      kind: "http",
      op,
      status: res.status,
      code,
      body,
    });
  }

  /**
   * Construye desde un error de transporte (no llegó a haber respuesta HTTP):
   * timeout (AbortSignal.timeout → TimeoutError), abort (AbortController),
   * red (fetch rechaza → TypeError), parse (res.json() → SyntaxError), o unknown.
   */
  static fromTransport(err: unknown, op: string): WooApiError {
    const e = err as { name?: string; message?: string } | null;
    const msg = e?.message ?? String(err);
    let kind: WooErrorKind = "unknown";
    if (e?.name === "TimeoutError") kind = "timeout";
    else if (e?.name === "AbortError") kind = "abort";
    else if (err instanceof TypeError) kind = "network";
    else if (err instanceof SyntaxError || e?.name === "SyntaxError") kind = "parse";
    return new WooApiError({
      message: `WooCommerce ${op} error: ${msg}`,
      kind,
      op,
      status: null,
    });
  }

  /** Type guard robusto (usa el brand, no instanceof). */
  static is(err: unknown): err is WooApiError {
    return (
      typeof err === "object" &&
      err !== null &&
      err instanceof WooApiError
    );
  }
}

/**
 * Función PURA. Clasifica un WooApiError en la taxonomía del contrato honesto.
 * NO decide comportamiento (eso es 1A.2): solo mapea status/kind → clase.
 *
 *   recoverable → reintentable (timeout, red, 5xx, 429).
 *   terminal    → no se arregla reintentando (400/4xx de validación).
 *   ambiguous   → no se puede decidir con lo que tenemos (401/403/404 + parse:
 *                 Woo respondió pero no se pudo interpretar). 1A.2 los trata como
 *                 PENDING_SYNC; la resolución fina (probe getProduct para 404,
 *                 carril de salud de integración para 401/403) queda para 1A.4.
 *   unknown     → genuino: transporte no mapeado / status raro / caso defensivo.
 */
export function classifyWooError(err: WooApiError): WooErrorClass {
  switch (err.kind) {
    case "timeout":
    case "network":
    case "abort":
      return "recoverable";
    case "parse":
      // Woo respondió pero PricEcom no pudo interpretar la respuesta: no sabemos
      // si Woo aplicó o no el cambio → AMBIGUO, no terminal. En pause/ignore
      // (idempotentes) reintentar es seguro. (Decisión 1A.2.)
      return "ambiguous";
    case "unknown":
      return "unknown";
    case "http": {
      const s = err.status;
      if (s == null) return "unknown";
      if (s >= 500) return "recoverable"; // 500/502/503/504/...
      if (s === 429) return "recoverable"; // rate limit
      if (s === 401 || s === 403 || s === 404) return "ambiguous";
      if (s >= 400) return "terminal"; // 400 payload/validación, 422, etc.
      return "unknown"; // 2xx/3xx no deberían llegar (solo !res.ok), defensa
    }
  }
}
