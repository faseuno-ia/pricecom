// G1c §1.4 — mensaje BOUNDED de markFailed para SkuFirstCompletenessError.
// El registro AUTORITATIVO del job fallido conserva reasonCode + counts + SHA + sample≤20,
// truncado determinístico, sin serializar contenido sensible; legacy → error.message exacto.
import { describe, it, expect } from "vitest";
import {
  SkuFirstCompletenessError,
  formatSkuFirstFailureMessage,
  selectFailureMessage,
  SKU_FIRST_FAILURE_MESSAGE_MAX_CHARS,
} from "@/lib/scraper/sku-first-start";

const PREFIX = "SKU_FIRST_COMPLETENESS_FAILED";
const parseMsg = (msg: string): Record<string, unknown> => {
  expect(msg.startsWith(PREFIX + " ")).toBe(true);
  return JSON.parse(msg.slice(PREFIX.length + 1));
};
const SHA = "a".repeat(64);
const urls = (n: number) => Array.from({ length: n }, (_, i) => `differenttouch.com.ar/productos/p${i}`);
const fullDiag = (extra: Record<string, unknown> = {}) => ({
  sitemapStartCount: 877, sitemapEndCount: 877, blockingSetCount: 877, walkSetCount: 800,
  blockingMissingCount: 77, minExpectedProducts: 700, addedDuringRunCount: 1, removedDuringRunCount: 2,
  blockingMissingSetSha256: SHA, blockingMissingSample: urls(20), snapshot: "END", ...extra,
});

describe("formatSkuFirstFailureMessage — contenido y prefijo", () => {
  it("preserva reasonCode + conteos + SHA + muestra, con prefijo", () => {
    const err = new SkuFirstCompletenessError("R2_SITEMAP_SET_MISMATCH", fullDiag());
    const msg = formatSkuFirstFailureMessage(err, SKU_FIRST_FAILURE_MESSAGE_MAX_CHARS);
    const o = parseMsg(msg);
    expect(o.reasonCode).toBe("R2_SITEMAP_SET_MISMATCH");
    expect(o.blockingMissingCount).toBe(77);
    expect(o.blockingMissingSetSha256).toBe(SHA);
    expect(o.sitemapStartCount).toBe(877);
    expect(Array.isArray(o.blockingMissingSample)).toBe(true);
  });
});

describe("formatSkuFirstFailureMessage — muestra acotada a 20", () => {
  it("una muestra de 30 nunca supera 20 en el mensaje", () => {
    const err = new SkuFirstCompletenessError("R2_SITEMAP_SET_MISMATCH", fullDiag({ blockingMissingSample: urls(30) }));
    const o = parseMsg(formatSkuFirstFailureMessage(err, SKU_FIRST_FAILURE_MESSAGE_MAX_CHARS));
    expect((o.blockingMissingSample as string[]).length).toBeLessThanOrEqual(20);
  });
});

describe("formatSkuFirstFailureMessage — truncado determinístico", () => {
  it("bajo límite moderado dropea/reduce la muestra pero conserva reasonCode+conteos+SHA", () => {
    const err = new SkuFirstCompletenessError("R2_SITEMAP_SET_MISMATCH", fullDiag());
    const msg = formatSkuFirstFailureMessage(err, 400);
    expect(msg.length).toBeLessThanOrEqual(400);
    const o = parseMsg(msg); // JSON válido
    expect(o.reasonCode).toBe("R2_SITEMAP_SET_MISMATCH");
    expect(o.blockingMissingCount).toBe(77);
    expect(o.blockingMissingSetSha256).toBe(SHA); // SHA íntegro (64 chars), nunca cortado
    expect((o.blockingMissingSetSha256 as string).length).toBe(64);
    const sample = (o.blockingMissingSample as string[] | undefined) ?? [];
    expect(sample.length).toBeLessThan(20);
  });
  it("es determinístico: misma entrada → misma salida", () => {
    const mk = () => new SkuFirstCompletenessError("R2_X", fullDiag());
    expect(formatSkuFirstFailureMessage(mk(), 400)).toBe(formatSkuFirstFailureMessage(mk(), 400));
  });
  it("piso patológico: límite mínimo → JSON válido con al menos reasonCode (SHA nunca cortado)", () => {
    const err = new SkuFirstCompletenessError("R2_TINY", fullDiag());
    const msg = formatSkuFirstFailureMessage(err, 45);
    const o = parseMsg(msg); // no lanza → JSON válido
    expect(o.reasonCode).toBe("R2_TINY");
    if (o.blockingMissingSetSha256 !== undefined) expect((o.blockingMissingSetSha256 as string).length).toBe(64);
  });
});

describe("selectFailureMessage — legacy intacto", () => {
  it("error legacy → error.message EXACTO", () => {
    expect(selectFailureMessage(new Error("Proveedor no encontrado"))).toBe("Proveedor no encontrado");
    expect(selectFailureMessage(new Error("Timeout al navegar"))).toBe("Timeout al navegar");
  });
  it("no-Error → String(err)", () => {
    expect(selectFailureMessage("boom")).toBe("boom");
  });
  it("SkuFirstCompletenessError → mensaje bounded (no el message crudo)", () => {
    const err = new SkuFirstCompletenessError("R2_SITEMAP_SET_MISMATCH", fullDiag());
    const msg = selectFailureMessage(err);
    expect(msg.startsWith(PREFIX + " {")).toBe(true);
    expect(parseMsg(msg).blockingMissingSetSha256).toBe(SHA);
  });
});

describe("formatSkuFirstFailureMessage — contenido sensible NO se serializa", () => {
  it("claves sensibles artificiales en diagnostics quedan fuera (whitelist)", () => {
    const err = new SkuFirstCompletenessError("R2_SITEMAP_SET_MISMATCH", fullDiag({
      password: "TOPSECRET_PW", cookie: "sess=TOPSECRET_COOKIE", authorization: "Bearer TOPSECRET_TOKEN",
      html: "<b>TOPSECRET_HTML</b>", price: "TOPSECRET_PRICE", fullUrlList: urls(877),
    }));
    const msg = formatSkuFirstFailureMessage(err, SKU_FIRST_FAILURE_MESSAGE_MAX_CHARS);
    for (const leak of ["TOPSECRET_PW", "TOPSECRET_COOKIE", "TOPSECRET_TOKEN", "TOPSECRET_HTML", "TOPSECRET_PRICE", "password", "cookie", "authorization", "fullUrlList"]) {
      expect(msg).not.toContain(leak);
    }
    // la muestra sigue acotada: nunca 877 URLs
    expect((parseMsg(msg).blockingMissingSample as string[]).length).toBeLessThanOrEqual(20);
  });
});
