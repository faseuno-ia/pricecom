// 2G-R7 · A — tests del witness de login fail-closed (puros) + estructural del caller SKU-first.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateSkuFirstAuthWitness, SkuFirstLoginError, isVisiblePrice } from "@/lib/scraper/sku-first-start";

const BASE = "https://differenttouch.com.ar";
const priced = (n: number) => Array.from({ length: n }, () => ({ price_number: 1234 }));

describe("2G-R7 · evaluateSkuFirstAuthWitness (puro)", () => {
  it("1 · ficha de producto con precio visible + no redirigido → established (PASS)", () => {
    const w = evaluateSkuFirstAuthWitness({ finalUrl: `${BASE}/productos/x`, baseUrl: BASE, variants: priced(3) });
    expect(w.established).toBe(true);
    expect(w.pricedVariantCount).toBe(3);
    expect(w.redirectedToLogin).toBe(false);
  });
  it("2 · sin witness de precio (variantes sin precio) → NO established (FAIL)", () => {
    const w = evaluateSkuFirstAuthWitness({ finalUrl: `${BASE}/productos/x`, baseUrl: BASE, variants: [{ price_number: 0 }, { price_number: null }] });
    expect(w.established).toBe(false);
    expect(w.pricedVariantCount).toBe(0);
  });
  it("3/4 · permanece en login URL → NO established (FAIL)", () => {
    const w = evaluateSkuFirstAuthWitness({ finalUrl: `${BASE}/account/login/`, baseUrl: BASE, variants: priced(3) });
    expect(w.established).toBe(false);
    expect(w.redirectedToLogin).toBe(true);
  });
  it("4bis · redirigido a baseUrl (raíz) → NO established (FAIL)", () => {
    const w = evaluateSkuFirstAuthWitness({ finalUrl: BASE, baseUrl: BASE, variants: priced(3) });
    expect(w.established).toBe(false);
    expect(w.redirectedToLogin).toBe(true);
  });
  it("5 · variantes vacías → NO established (FAIL)", () => {
    const w = evaluateSkuFirstAuthWitness({ finalUrl: `${BASE}/productos/x`, baseUrl: BASE, variants: [] });
    expect(w.established).toBe(false);
  });
  it("isVisiblePrice: número finito > 0", () => {
    expect(isVisiblePrice(10)).toBe(true);
    for (const v of [0, -1, NaN, Infinity, null, undefined, "10", {}]) expect(isVisiblePrice(v as any)).toBe(false);
  });
});

describe("2G-R7 · SkuFirstLoginError", () => {
  it("reasonCode estable + mensaje sin secretos", () => {
    const e = new SkuFirstLoginError("PROVIDER_LOGIN_NOT_ESTABLISHED", { probes: 3, redirectedToLogin: true });
    expect(e.reasonCode).toBe("PROVIDER_LOGIN_NOT_ESTABLISHED");
    expect(e.message).toContain("PROVIDER_LOGIN_NOT_ESTABLISHED");
    // 8 · nunca password/cookie/token en el error
    expect(e.message).not.toMatch(/password|cookie|token|authorization|encrypted/i);
  });
});

describe("2G-R7 · caller SKU-first (estructural, CI-safe)", () => {
  const src = readFileSync(resolve(process.cwd(), "lib/scraper/scraper.service.ts"), "utf8");
  const witnessIdx = src.indexOf("evaluateSkuFirstAuthWitness(");
  const walkIdx = src.indexOf("runSkuFirstWalk(deps)");
  const completenessIdx = src.indexOf("resolveTwoSnapshotCompleteness(");
  const cadenceIdx = src.indexOf("[SkuFirstCadence]");

  it("6 · el witness está guardado por provider.requiresLogin", () => {
    expect(src).toMatch(/if \(provider\.requiresLogin\)/);
  });
  it("7 · el witness (A) corre ANTES del walk (no discovery/walk tras fail-closed)", () => {
    expect(witnessIdx).toBeGreaterThan(-1);
    expect(walkIdx).toBeGreaterThan(-1);
    expect(witnessIdx).toBeLessThan(walkIdx);
  });
  it("2 · lanza PROVIDER_LOGIN_NOT_ESTABLISHED cuando no hay witness", () => {
    expect(src).toMatch(/throw new SkuFirstLoginError\("PROVIDER_LOGIN_NOT_ESTABLISHED"/);
  });
  it("§10 · [SkuFirstCadence] se emite ANTES de la decisión de completeness", () => {
    expect(cadenceIdx).toBeGreaterThan(-1);
    expect(completenessIdx).toBeGreaterThan(-1);
    expect(cadenceIdx).toBeLessThan(completenessIdx);
  });
  it("observabilidad: onProductObserved + tags zero-variant/capture-failure presentes", () => {
    expect(src).toMatch(/onProductObserved:/);
    // el tag se arma dinámicamente (`[${tag}]`), así que se busca el identificador del tag.
    expect(src).toContain("SkuFirstZeroVariant");
    expect(src).toContain("SkuFirstCaptureFailure");
  });
});
