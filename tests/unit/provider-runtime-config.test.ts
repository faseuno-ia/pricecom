// A3-P1 — builder puro provider-runtime-config: resolveLoginFlowStrategy, resolveLoginUrl,
// buildProviderRuntimeConfig. Ejecuta las funciones reales.
import { describe, it, expect } from "vitest";
import {
  resolveLoginFlowStrategy,
  resolveLoginUrl,
  buildProviderRuntimeConfig,
} from "@/lib/scraper/provider-runtime-config";

const DT_BASE = "https://differenttouch.com.ar/";
const DT_LOGIN = "https://differenttouch.com.ar/account/login/";

describe("resolveLoginFlowStrategy", () => {
  it("null/undefined/blank/whitespace → LEGACY", () => {
    for (const v of [null, undefined, "", " ", "\t\n"] as unknown[]) {
      expect(resolveLoginFlowStrategy(v)).toBe("LEGACY");
    }
  });
  it('"LEGACY" → LEGACY', () => expect(resolveLoginFlowStrategy("LEGACY")).toBe("LEGACY"));
  it('"DOCUMENT_REDIRECT" → DOCUMENT_REDIRECT', () =>
    expect(resolveLoginFlowStrategy("DOCUMENT_REDIRECT")).toBe("DOCUMENT_REDIRECT"));
  it("desconocido → throw con field + valor", () => {
    expect(() => resolveLoginFlowStrategy("REDIRECT")).toThrow(/field=loginFlowStrategy/);
    expect(() => resolveLoginFlowStrategy("REDIRECT")).toThrow(/REDIRECT/);
  });
  it('" DOCUMENT_REDIRECT " → throw (no normaliza)', () =>
    expect(() => resolveLoginFlowStrategy(" DOCUMENT_REDIRECT ")).toThrow(/field=loginFlowStrategy/));
});

describe("resolveLoginUrl", () => {
  it("ausente/blank + LEGACY → null (no configurada)", () => {
    expect(resolveLoginUrl(null, DT_BASE, "LEGACY")).toBeNull();
    expect(resolveLoginUrl("   ", DT_BASE, "LEGACY")).toBeNull();
  });
  it("ausente + DOCUMENT_REDIRECT → throw (invariante cruzada nombra ambos campos)", () => {
    expect(() => resolveLoginUrl(null, DT_BASE, "DOCUMENT_REDIRECT")).toThrow(/field=loginFlowStrategy=DOCUMENT_REDIRECT/);
    expect(() => resolveLoginUrl(null, DT_BASE, "DOCUMENT_REDIRECT")).toThrow(/field=loginUrl/);
  });
  it("blank + DOCUMENT_REDIRECT → throw", () =>
    expect(() => resolveLoginUrl("  ", DT_BASE, "DOCUMENT_REDIRECT")).toThrow(/field=loginUrl/));
  it("https válida mismo host + path exacto → pasa", () => {
    expect(resolveLoginUrl(DT_LOGIN, DT_BASE, "DOCUMENT_REDIRECT")).toBe(DT_LOGIN);
  });
  it("http → throw", () =>
    expect(() => resolveLoginUrl("http://differenttouch.com.ar/account/login/", DT_BASE, "DOCUMENT_REDIRECT")).toThrow(/protocolo-no-https/));
  it("host mismatch → throw", () =>
    expect(() => resolveLoginUrl("https://otro.com/account/login/", DT_BASE, "DOCUMENT_REDIRECT")).toThrow(/host-mismatch/));
  it("puerto distinto → throw (altera host)", () =>
    expect(() => resolveLoginUrl("https://differenttouch.com.ar:8443/account/login/", DT_BASE, "DOCUMENT_REDIRECT")).toThrow(/host-mismatch/));
  it("path distinto → throw", () =>
    expect(() => resolveLoginUrl("https://differenttouch.com.ar/login/", DT_BASE, "DOCUMENT_REDIRECT")).toThrow(/pathname/));
  it("path sin slash final → throw", () =>
    expect(() => resolveLoginUrl("https://differenttouch.com.ar/account/login", DT_BASE, "DOCUMENT_REDIRECT")).toThrow(/pathname/));
  it("query → throw", () =>
    expect(() => resolveLoginUrl("https://differenttouch.com.ar/account/login/?x=1", DT_BASE, "DOCUMENT_REDIRECT")).toThrow(/query-presente/));
  it("hash → throw", () =>
    expect(() => resolveLoginUrl("https://differenttouch.com.ar/account/login/#f", DT_BASE, "DOCUMENT_REDIRECT")).toThrow(/hash-presente/));
  it("credenciales embebidas → throw (nunca imprime la credencial)", () => {
    expect(() => resolveLoginUrl("https://u:p@differenttouch.com.ar/account/login/", DT_BASE, "DOCUMENT_REDIRECT")).toThrow(/credenciales-embebidas/);
  });
  it("URL inválida → throw", () =>
    expect(() => resolveLoginUrl("no-es-url", DT_BASE, "DOCUMENT_REDIRECT")).toThrow(/URL-invalida/));
  it("baseUrl inválida → throw", () =>
    expect(() => resolveLoginUrl(DT_LOGIN, "no-es-url", "DOCUMENT_REDIRECT")).toThrow(/baseUrl-invalida/));
});

describe("buildProviderRuntimeConfig — regresión 9 providers (todos null)", () => {
  it("extractionMode/loginUrl/loginFlowStrategy null → LEGACY/LEGACY/null, sin throw, NO SKU-first", () => {
    const rc = buildProviderRuntimeConfig({
      provider: { baseUrl: "https://ejemplo.com/" },
      scraperConfig: { extractionMode: null, loginUrl: null, loginFlowStrategy: null },
    });
    expect(rc).toEqual({
      effectiveExtractionMode: "LEGACY",
      effectiveLoginFlowStrategy: "LEGACY",
      effectiveLoginUrl: null,
    });
  });
  it("scraperConfig null completo → LEGACY/LEGACY/null", () => {
    const rc = buildProviderRuntimeConfig({ provider: { baseUrl: "https://ejemplo.com/" }, scraperConfig: null });
    expect(rc.effectiveExtractionMode).toBe("LEGACY");
    expect(rc.effectiveLoginFlowStrategy).toBe("LEGACY");
    expect(rc.effectiveLoginUrl).toBeNull();
  });
  it("extractionMode desconocido → throw (autoridad in-situ, no capturada por el builder)", () => {
    expect(() =>
      buildProviderRuntimeConfig({
        provider: { baseUrl: "https://ejemplo.com/" },
        scraperConfig: { extractionMode: "XXX", loginUrl: null, loginFlowStrategy: null },
      })
    ).toThrow(/field=extractionMode/);
  });
  it("DOCUMENT_REDIRECT + loginUrl ausente → throw (invariante cruzada en el builder)", () => {
    expect(() =>
      buildProviderRuntimeConfig({
        provider: { baseUrl: DT_BASE },
        scraperConfig: { extractionMode: null, loginUrl: null, loginFlowStrategy: "DOCUMENT_REDIRECT" },
      })
    ).toThrow(/DOCUMENT_REDIRECT/);
  });
});

describe("§11.10 — pureza del builder", () => {
  const input = {
    provider: { baseUrl: DT_BASE },
    scraperConfig: {
      extractionMode: "TIENDANUBE_LS_VARIANTS_SKU_FIRST",
      loginUrl: DT_LOGIN,
      loginFlowStrategy: "DOCUMENT_REDIRECT",
    },
  };
  it("determinístico: misma entrada → misma salida", () => {
    expect(buildProviderRuntimeConfig(input)).toEqual(buildProviderRuntimeConfig(input));
  });
  it("no muta el input", () => {
    const snapshot = JSON.parse(JSON.stringify(input));
    buildProviderRuntimeConfig(input);
    expect(input).toEqual(snapshot);
  });
});
