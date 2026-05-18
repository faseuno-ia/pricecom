// Cliente WooCommerce REST API v3.
// Docs: https://woocommerce.github.io/woocommerce-rest-api-docs/
//
// Auth via Basic con consumer_key + consumer_secret. Para tiendas que
// soportan HTTPS y permission_callback estándar, esto alcanza.

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

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try {
      // /system_status requiere permisos read; si funciona, las credenciales
      // son válidas. Si la tienda no expone ese endpoint, probamos /products
      // como fallback.
      const res = await fetch(`${this.baseUrl}/system_status`, {
        headers: { Authorization: this.authHeader() },
        signal: AbortSignal.timeout(10000),
      });
      if (res.ok) return { ok: true };
      // Fallback: si /system_status devuelve 401/403/404, probamos /products
      if (res.status === 404 || res.status === 401 || res.status === 403) {
        const probe = await fetch(`${this.baseUrl}/products?per_page=1`, {
          headers: { Authorization: this.authHeader() },
          signal: AbortSignal.timeout(10000),
        });
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

  async getProducts(page = 1, perPage = 100): Promise<WooProduct[]> {
    const res = await fetch(
      `${this.baseUrl}/products?page=${page}&per_page=${perPage}&status=any`,
      {
        headers: { Authorization: this.authHeader() },
        signal: AbortSignal.timeout(30000),
      }
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

  async updateProduct(
    productId: number,
    data: {
      regular_price?: string;
      stock_quantity?: number;
      manage_stock?: boolean;
      status?: string;
      name?: string;
      description?: string;
    }
  ): Promise<WooProduct> {
    const res = await fetch(`${this.baseUrl}/products/${productId}`, {
      method: "PUT",
      headers: {
        Authorization: this.authHeader(),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`WooCommerce update error: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return res.json();
  }

  async updateProductStatus(
    productId: number,
    status: "publish" | "draft" | "private" | "pending"
  ): Promise<WooProduct> {
    return this.updateProduct(productId, { status });
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
      const res = await fetch(
        `${this.baseUrl}/products/categories?page=${page}&per_page=100&hide_empty=false`,
        {
          headers: { Authorization: this.authHeader() },
          signal: AbortSignal.timeout(30000),
        }
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
