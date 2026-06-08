// Unit (sin DB, sin red real): client.ts ahora lanza WooApiError estructurado
// en vez de Error plano con el status embebido en un string. Mockeamos `fetch`
// global. Aditivo (1A.1): el message se preserva; solo cambia el TIPO de error.

import { describe, it, expect, vi, afterEach } from "vitest";
import { WooCommerceClient } from "@/lib/integrations/woocommerce/client";
import { WooApiError } from "@/lib/integrations/woocommerce/woo-api-error";

const client = new WooCommerceClient("https://shop.example.test", "ck", "cs");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("client.ts — errores HTTP → WooApiError", () => {
  it("updateProduct lanza WooApiError con status y code en respuesta no-OK", async () => {
    const body = JSON.stringify({ code: "woocommerce_rest_product_invalid_id", message: "Invalid ID." });
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 404 })));

    await expect(client.updateProduct(123, { status: "draft" })).rejects.toMatchObject({
      isWooApiError: true,
      kind: "http",
      status: 404,
      code: "woocommerce_rest_product_invalid_id",
    });
  });

  it("createProduct lanza WooApiError con status 400", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 400 })));
    const p = client.createProduct({ name: "x", sku: "X-1", regular_price: "1.00", status: "publish" });
    await expect(p).rejects.toBeInstanceOf(WooApiError);
    await expect(p).rejects.toMatchObject({ status: 400 });
  });
});

describe("client.ts — errores de transporte → WooApiError", () => {
  it("falla de red (fetch rechaza) → WooApiError kind=network", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    await expect(client.updateProduct(1, { status: "draft" })).rejects.toMatchObject({
      isWooApiError: true,
      kind: "network",
      status: null,
    });
  });
});

describe("client.ts — getProduct 404 sigue devolviendo null (regresión)", () => {
  it("no lanza: 404 en getProduct → null", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    await expect(client.getProduct(999)).resolves.toBeNull();
  });
});
