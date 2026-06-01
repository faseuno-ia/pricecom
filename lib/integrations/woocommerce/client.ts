// Cliente WooCommerce REST API v3.
// Docs: https://woocommerce.github.io/woocommerce-rest-api-docs/
//
// Auth via Basic con consumer_key + consumer_secret. Algunos hostings
// (cPanel/Hostinger con mod_security agresivo) strippean el header
// Authorization en /wp-json y devuelven 401 aunque las credenciales sean
// válidas. Como fallback reintentamos con las credenciales en query params
// (?consumer_key=...&consumer_secret=...), que es soportado por WooCommerce
// para conexiones HTTPS.

import { decrypt } from "@/lib/utils/crypto";

export interface WooProduct {
  id: number;
  name: string;
  sku: string;
  status: string; // "publish" | "draft" | "pending" | "private" | "trash"
  regular_price: string;
  price: string;
  stock_quantity: number | null;
  manage_stock: boolean;
  stock_status: string; // "instock" | "outofstock" | "onbackorder"
  permalink: string;
  images: { src: string }[];
  categories: { id: number; name: string; slug: string }[];
  description: string;
}

export interface WooCategory {
  id: number;
  name: string;
  slug: string;
  parent: number; // 0 si es raíz
  count: number;
}

export class WooCommerceClient {
  private baseUrl: string;
  private consumerKey: string;
  private consumerSecret: string;

  constructor(storeUrl: string, consumerKey: string, consumerSecret: string) {
    this.baseUrl = storeUrl.replace(/\/+$/, "") + "/wp-json/wc/v3";
    this.consumerKey = consumerKey;
    this.consumerSecret = consumerSecret;
  }

  static fromIntegration(integration: {
    storeUrl: string;
    consumerKeyEncrypted: string | null;
    consumerSecretEncrypted: string | null;
  }): WooCommerceClient {
    if (
      !integration.consumerKeyEncrypted ||
      !integration.consumerSecretEncrypted
    ) {
      throw new Error("Credenciales WooCommerce no configuradas");
    }
    return new WooCommerceClient(
      integration.storeUrl,
      decrypt(integration.consumerKeyEncrypted),
      decrypt(integration.consumerSecretEncrypted)
    );
  }

  private authHeader(): string {
    return (
      "Basic " +
      Buffer.from(`${this.consumerKey}:${this.consumerSecret}`).toString("base64")
    );
  }

  private authParams(): string {
    return (
      `consumer_key=${encodeURIComponent(this.consumerKey)}` +
      `&consumer_secret=${encodeURIComponent(this.consumerSecret)}`
    );
  }

  // Wrapper compartido: intenta primero con Basic Auth; si recibe 401,
  // reintenta el mismo request con credenciales en query params.
  private async fetchWoo(
    url: string,
    options: RequestInit = {}
  ): Promise<Response> {
    const signal = options.signal ?? AbortSignal.timeout(30000);
    const res = await fetch(url, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
      },
      signal,
    });

    if (res.status !== 401) return res;

    // Algunos hostings strippean Authorization — reintento con query params.
    const separator = url.includes("?") ? "&" : "?";
    const urlWithAuth = `${url}${separator}${this.authParams()}`;
    return fetch(urlWithAuth, {
      ...options,
      headers: {
        ...options.headers,
        "Content-Type": "application/json",
      },
      signal: options.signal ?? AbortSignal.timeout(30000),
    });
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      // /system_status requiere permisos read; si funciona, las credenciales
      // son válidas. Si la tienda no expone ese endpoint, probamos /products
      // como fallback.
      const res = await this.fetchWoo(`${this.baseUrl}/system_status`, {
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return { ok: true };
      // 401/403/404 → probamos /products como fallback de endpoint
      if (res.status === 404 || res.status === 401 || res.status === 403) {
        const probe = await this.fetchWoo(
          `${this.baseUrl}/products?per_page=1`,
          { signal: AbortSignal.timeout(10000) }
        );
        if (probe.ok) return { ok: true };
        return { ok: false, error: `HTTP ${probe.status} probing products` };
      }
      return { ok: false, error: `HTTP ${res.status}` };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Error de conexión",
      };
    }
  }

  // Devuelve null si el producto no existe (404). Cualquier otro error no-OK
  // se propaga — así diferenciamos "no está" de "Woo respondió mal".
  async getProduct(productId: number): Promise<WooProduct | null> {
    const res = await this.fetchWoo(`${this.baseUrl}/products/${productId}`);
    if (res.status === 404) return null;
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `WooCommerce get error: HTTP ${res.status} ${text.slice(0, 200)}`
      );
    }
    return res.json();
  }

  /** Devuelve los productos Woo que tienen ese SKU. Si el array es vacío, no
   *  hay duplicados. Usado para el guard pre-push de Fase 4B (Colisión 2). */
  async findProductsBySku(sku: string): Promise<WooProduct[]> {
    const res = await this.fetchWoo(
      `${this.baseUrl}/products?sku=${encodeURIComponent(sku)}`
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `WooCommerce findProductsBySku error: HTTP ${res.status} ${text.slice(0, 200)}`
      );
    }
    return res.json();
  }

  async getProducts(page = 1, perPage = 100): Promise<WooProduct[]> {
    const res = await this.fetchWoo(
      `${this.baseUrl}/products?page=${page}&per_page=${perPage}&status=any`
    );
    if (!res.ok) {
      throw new Error(`WooCommerce products error: HTTP ${res.status}`);
    }
    return res.json();
  }

  async getAllProducts(): Promise<WooProduct[]> {
    const all: WooProduct[] = [];
    let page = 1;
    // Tope duro de 100 páginas (10k productos) para no quedarnos colgados si
    // la API miente sobre el tamaño del batch.
    while (page <= 100) {
      const batch = await this.getProducts(page, 100);
      all.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    return all;
  }

  // ─── Métodos de escritura (push de cambios a WooCommerce) ──────────────
  // Estructura lista para el sync engine; los handlers del worker llaman a
  // estos métodos cuando se procesan publicaciones con pendingSync=true.

  async createProduct(data: {
    name: string;
    sku: string;
    regular_price: string;
    status: "publish" | "draft" | "private" | "pending";
    description?: string;
    stock_quantity?: number;
    manage_stock?: boolean;
    categories?: { id: number }[];
    images?: { src: string }[];
  }): Promise<WooProduct> {
    const res = await this.fetchWoo(`${this.baseUrl}/products`, {
      method: "POST",
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `WooCommerce create error: HTTP ${res.status} ${text.slice(0, 200)}`
      );
    }
    return res.json();
  }

  async updateProduct(
    productId: number,
    data: {
      regular_price?: string;
      stock_quantity?: number;
      manage_stock?: boolean;
      status?: string;
      name?: string;
      description?: string;
      categories?: { id: number }[];
      /** SKU comercial. Solo se usa al renombrar el SKU desde PricEcom
       *  (endpoint PUT /api/catalog/publications/[id]/sku). En sync normal
       *  el SKU es propiedad de Woo y no se manda. */
      sku?: string;
    }
  ): Promise<WooProduct> {
    const res = await this.fetchWoo(`${this.baseUrl}/products/${productId}`, {
      method: "PUT",
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `WooCommerce update error: HTTP ${res.status} ${text.slice(0, 200)}`
      );
    }
    return res.json();
  }

  async updateProductStatus(
    productId: number,
    status: "publish" | "draft" | "private" | "pending"
  ): Promise<WooProduct> {
    return this.updateProduct(productId, { status });
  }

  // force=true salta la papelera y elimina definitivamente. Sin force el
  // producto va a "trash" y reaparece si el cliente lo restaura.
  async deleteProduct(productId: number, force = true): Promise<WooProduct> {
    const res = await this.fetchWoo(
      `${this.baseUrl}/products/${productId}?force=${force}`,
      { method: "DELETE" }
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `WooCommerce delete error: HTTP ${res.status} ${text.slice(0, 200)}`
      );
    }
    return res.json();
  }

  async updateProductPrice(productId: number, price: number): Promise<WooProduct> {
    return this.updateProduct(productId, { regular_price: price.toFixed(2) });
  }

  async updateProductStock(productId: number, quantity: number): Promise<WooProduct> {
    return this.updateProduct(productId, {
      stock_quantity: quantity,
      manage_stock: true,
    });
  }

  async getCategories(): Promise<WooCategory[]> {
    const all: WooCategory[] = [];
    let page = 1;
    while (page <= 50) {
      const res = await this.fetchWoo(
        `${this.baseUrl}/products/categories?page=${page}&per_page=100&hide_empty=false`
      );
      if (!res.ok) {
        throw new Error(`WooCommerce categories error: HTTP ${res.status}`);
      }
      const batch = (await res.json()) as WooCategory[];
      all.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    return all;
  }
}
