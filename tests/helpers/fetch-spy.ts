// Spy de TRANSPORTE para WooCommerce: reemplaza `globalThis.fetch`.
//
// Por qué a nivel transporte y no a nivel método del cliente: la exigencia de C2-DESIGN-1 es
// "CERO llamadas HTTP a Woo, incluido cualquier GET". Contar invocaciones de
// `client.createProduct` / `client.findProductsBySku` dejaría escapar cualquier verbo nuevo o
// cualquier método que se agregue más adelante. `fetch` es el único cuello real: todo pasa por
// `WooCommerceClient.fetchWoo` (lib/integrations/woocommerce/client.ts:83).
//
// El router por defecto responde como una tienda vacía y sana:
//   GET  /products?sku=... → []            (sin colisión de SKU)
//   POST /products         → producto creado (id 9001+)
//   PUT  /products/:id     → producto actualizado
// De modo que el camino de creación COMPLETA con éxito. Eso es deliberado: el test DEFECT_RED
// tiene que demostrar que hoy la publicación accidental efectivamente ocurre, no que falla.

export interface FetchCall {
  method: string;
  url: string;
  body: unknown;
}

export interface FetchSpyHandle {
  calls: FetchCall[];
  count(method?: string): number;
  byMethod(): Record<string, number>;
  restore(): void;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

let wooIdSeq = 9000;

/**
 * Handler programable. Recibe la url y el init ya normalizados y devuelve la Response.
 * Si LANZA, el throw se propaga tal cual al código bajo test — así se simulan errores de
 * transporte reales (ECONNREFUSED / ENOTFOUND / TimeoutError), que en `fetch` de Node NO
 * son respuestas HTTP sino excepciones.
 */
export type FetchHandler = (
  url: string,
  init: RequestInit | undefined,
) => Promise<Response>;

/**
 * Spy genérico de transporte. Registra toda llamada a `globalThis.fetch` y delega la respuesta
 * en `handler`. Sin handler, responde 200 con `{}` (útil sólo para contar llamadas).
 *
 * `installWooFetchSpy` es este mismo spy con el router de WooCommerce como handler.
 */
export function installFetchSpy(handler?: FetchHandler): FetchSpyHandle {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];

  const spy = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, url, body });
    if (handler) return handler(url, init);
    return jsonResponse({});
  };

  globalThis.fetch = spy as unknown as typeof globalThis.fetch;

  return {
    calls,
    count(method?: string) {
      return method
        ? calls.filter((c) => c.method === method.toUpperCase()).length
        : calls.length;
    },
    byMethod() {
      const out: Record<string, number> = { GET: 0, POST: 0, PUT: 0, DELETE: 0 };
      for (const c of calls) out[c.method] = (out[c.method] ?? 0) + 1;
      return out;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}

export function installWooFetchSpy(): FetchSpyHandle {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];

  const spy = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === "string" ? input : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    let body: unknown = null;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    calls.push({ method, url, body });

    // GET de verificación de SKU (assertSkuNotInWoo → findProductsBySku): tienda sin colisión.
    if (method === "GET" && url.includes("/products?sku=")) return jsonResponse([]);

    if (method === "POST" && /\/products$/.test(url)) {
      wooIdSeq += 1;
      const payload = (body ?? {}) as Record<string, unknown>;
      return jsonResponse({
        id: wooIdSeq,
        name: payload.name ?? "",
        sku: payload.sku ?? "",
        status: payload.status ?? "publish",
        regular_price: payload.regular_price ?? "0.00",
        price: payload.regular_price ?? "0.00",
        permalink: `https://shop.example.test/?p=${wooIdSeq}`,
        stock_quantity: payload.stock_quantity ?? null,
        manage_stock: payload.manage_stock ?? false,
        stock_status: "instock",
        images: [],
        categories: payload.categories ?? [],
        description: payload.description ?? "",
      });
    }

    if (method === "PUT") {
      const idFromUrl = Number(/\/products\/(\d+)/.exec(url)?.[1] ?? 0);
      const payload = (body ?? {}) as Record<string, unknown>;
      return jsonResponse({
        id: idFromUrl,
        name: payload.name ?? "",
        sku: payload.sku ?? "EXISTING-SKU",
        status: payload.status ?? "publish",
        regular_price: payload.regular_price ?? "0.00",
        price: payload.regular_price ?? "0.00",
        permalink: `https://shop.example.test/?p=${idFromUrl}`,
        stock_quantity: null,
        manage_stock: false,
        stock_status: "instock",
        images: [],
        categories: [],
        description: "",
      });
    }

    if (method === "GET") return jsonResponse([]);

    return jsonResponse({}, 200);
  };

  globalThis.fetch = spy as unknown as typeof globalThis.fetch;

  return {
    calls,
    count(method?: string) {
      return method
        ? calls.filter((c) => c.method === method.toUpperCase()).length
        : calls.length;
    },
    byMethod() {
      const out: Record<string, number> = { GET: 0, POST: 0, PUT: 0, DELETE: 0 };
      for (const c of calls) out[c.method] = (out[c.method] ?? 0) + 1;
      return out;
    },
    restore() {
      globalThis.fetch = original;
    },
  };
}
