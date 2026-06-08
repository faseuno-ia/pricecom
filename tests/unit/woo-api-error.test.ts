// Unit (sin DB, sin .env): WooApiError + classifyWooError.
// 1A.1 base técnica del contrato honesto: error estructurado de Woo + función
// pura de clasificación. classifyWooError NO está cableado a comportamiento
// todavía — acá solo se valida que clasifica correctamente.

import { describe, it, expect } from "vitest";
import {
  WooApiError,
  classifyWooError,
} from "@/lib/integrations/woocommerce/woo-api-error";

describe("WooApiError.fromResponse", () => {
  it("estructura un error HTTP con status, body y code del JSON de Woo", async () => {
    const body = JSON.stringify({
      code: "product_invalid_sku",
      message: "Invalid or duplicated SKU.",
      data: { status: 400 },
    });
    const res = new Response(body, { status: 400 });
    const err = await WooApiError.fromResponse(res, "update");

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(WooApiError);
    expect(err.isWooApiError).toBe(true);
    expect(err.kind).toBe("http");
    expect(err.status).toBe(400);
    expect(err.code).toBe("product_invalid_sku");
    expect(err.body).toContain("product_invalid_sku");
    expect(err.op).toBe("update");
    // message preserva el formato actual de client.ts (compatibilidad de syncError)
    expect(err.message).toBe(
      `WooCommerce update error: HTTP 400 ${body.slice(0, 200)}`
    );
  });

  it("tolera body no-JSON: code=null, body preservado", async () => {
    const res = new Response("<html>502 Bad Gateway</html>", { status: 502 });
    const err = await WooApiError.fromResponse(res, "create");
    expect(err.status).toBe(502);
    expect(err.code).toBeNull();
    expect(err.body).toContain("Bad Gateway");
    expect(err.kind).toBe("http");
  });
});

describe("WooApiError.fromTransport", () => {
  it("clasifica el kind según el tipo de error de transporte (status null)", () => {
    const timeout = WooApiError.fromTransport(
      Object.assign(new Error("timed out"), { name: "TimeoutError" }),
      "update"
    );
    expect(timeout.kind).toBe("timeout");
    expect(timeout.status).toBeNull();

    const abort = WooApiError.fromTransport(
      Object.assign(new Error("aborted"), { name: "AbortError" }),
      "update"
    );
    expect(abort.kind).toBe("abort");

    const network = WooApiError.fromTransport(new TypeError("fetch failed"), "update");
    expect(network.kind).toBe("network");

    const parse = WooApiError.fromTransport(new SyntaxError("Unexpected token"), "update");
    expect(parse.kind).toBe("parse");

    const unknown = WooApiError.fromTransport(new Error("???"), "update");
    expect(unknown.kind).toBe("unknown");
  });
});

describe("WooApiError.is", () => {
  it("type guard: true solo para WooApiError", () => {
    const woo = new WooApiError({ message: "x", kind: "http", status: 500, op: "x" });
    expect(WooApiError.is(woo)).toBe(true);
    expect(WooApiError.is(new Error("plain"))).toBe(false);
    expect(WooApiError.is({ isWooApiError: true })).toBe(false);
    expect(WooApiError.is(null)).toBe(false);
  });
});

describe("classifyWooError", () => {
  const http = (status: number) =>
    new WooApiError({ message: "x", kind: "http", status, op: "x" });

  it("recoverable: timeout / network / abort", () => {
    expect(classifyWooError(WooApiError.fromTransport(Object.assign(new Error(), { name: "TimeoutError" }), "x"))).toBe("recoverable");
    expect(classifyWooError(WooApiError.fromTransport(new TypeError("fetch failed"), "x"))).toBe("recoverable");
    expect(classifyWooError(WooApiError.fromTransport(Object.assign(new Error(), { name: "AbortError" }), "x"))).toBe("recoverable");
  });

  it("recoverable: 500 / 502 / 503 / 504 y 429 (rate limit)", () => {
    for (const s of [500, 502, 503, 504, 429]) {
      expect(classifyWooError(http(s))).toBe("recoverable");
    }
  });

  it("terminal: 400 y otros 4xx de validación", () => {
    for (const s of [400, 422]) {
      expect(classifyWooError(http(s))).toBe("terminal");
    }
  });

  it("ambiguous: 401 / 403 / 404 y parse (Woo respondió pero no se pudo interpretar)", () => {
    for (const s of [401, 403, 404]) {
      expect(classifyWooError(http(s))).toBe("ambiguous");
    }
    // parse = Woo respondió pero PricEcom no pudo interpretar la respuesta → no
    // sabemos si aplicó → ambiguo (no terminal). Reintentar es seguro en pause/ignore.
    expect(classifyWooError(WooApiError.fromTransport(new SyntaxError("bad"), "x"))).toBe("ambiguous");
  });

  it("unknown: sólo el genuino (transporte no mapeado / caso defensivo)", () => {
    expect(classifyWooError(WooApiError.fromTransport(new Error("???"), "x"))).toBe("unknown");
  });
});
