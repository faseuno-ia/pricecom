// G1 §6.5/§6.6 — invariante builder LEGACY+loginUrl y goto condicional de performLogin.
import { describe, it, expect, vi } from "vitest";
import { buildProviderRuntimeConfig } from "@/lib/scraper/provider-runtime-config";
import { ScraperService } from "@/lib/scraper/scraper.service";

const DT_BASE = "https://differenttouch.com.ar/";
const DT_LOGIN = "https://differenttouch.com.ar/account/login/";
const cfg = (loginUrl: string | null, flow: string) => ({ extractionMode: null, loginUrl, loginFlowStrategy: flow });

describe("§6.6 — builder: LEGACY admite loginUrl poblada o null", () => {
  it("LEGACY + loginUrl null → válido, effectiveLoginUrl null", () => {
    const rc = buildProviderRuntimeConfig({ provider: { baseUrl: DT_BASE }, scraperConfig: cfg(null, "LEGACY") });
    expect(rc.effectiveLoginFlowStrategy).toBe("LEGACY");
    expect(rc.effectiveLoginUrl).toBeNull();
  });
  it("LEGACY + loginUrl válida → válido, effectiveLoginUrl poblada (LEGACY_WITH_POPULATED_LOGIN_URL_ALLOWED)", () => {
    const rc = buildProviderRuntimeConfig({ provider: { baseUrl: DT_BASE }, scraperConfig: cfg(DT_LOGIN, "LEGACY") });
    expect(rc.effectiveLoginFlowStrategy).toBe("LEGACY");
    expect(rc.effectiveLoginUrl).toBe(DT_LOGIN);
  });
  it("DOCUMENT_REDIRECT + loginUrl válida → válido", () => {
    const rc = buildProviderRuntimeConfig({ provider: { baseUrl: DT_BASE }, scraperConfig: cfg(DT_LOGIN, "DOCUMENT_REDIRECT") });
    expect(rc.effectiveLoginUrl).toBe(DT_LOGIN);
  });
  it("DOCUMENT_REDIRECT + null → error", () => {
    expect(() => buildProviderRuntimeConfig({ provider: { baseUrl: DT_BASE }, scraperConfig: cfg(null, "DOCUMENT_REDIRECT") })).toThrow(/DOCUMENT_REDIRECT/);
  });
  it("host distinto / query / hash / credenciales → error (cualquier estrategia)", () => {
    const bad = (loginUrl: string) => () => buildProviderRuntimeConfig({ provider: { baseUrl: DT_BASE }, scraperConfig: cfg(loginUrl, "LEGACY") });
    expect(bad("https://otro.com/account/login/")).toThrow(/host-mismatch/);
    expect(bad(DT_LOGIN + "?x=1")).toThrow(/query/);
    expect(bad(DT_LOGIN + "#f")).toThrow(/hash/);
    expect(bad("https://u:p@differenttouch.com.ar/account/login/")).toThrow(/credenciales/);
  });
});

describe("§6.5 — performLogin: goto condicional (poblada → navega; null → no navega)", () => {
  const mkPage = () => ({
    goto: vi.fn(async () => {}),
    url: () => DT_BASE,
    locator: () => ({ count: async () => 0, first: () => ({ isVisible: async () => false }) }),
    fill: vi.fn(async () => {}),
    click: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async () => {}),
  });
  const onLog = async () => {};
  // encryptedPassword inválido → decrypt lanza → performLogin lanza, PERO el goto condicional
  // (previo al try) ya se evaluó: eso es lo que se asevera.
  const provider = { username: "u", encryptedPassword: "not-a-valid-ciphertext" };

  it("effectiveLoginUrl poblada → navega a la loginUrl validada", async () => {
    const page = mkPage();
    await expect(new ScraperService().performLogin(page as any, provider as any, null, onLog, DT_LOGIN)).rejects.toThrow();
    expect(page.goto).toHaveBeenCalledWith(DT_LOGIN, { waitUntil: "domcontentloaded" });
  });
  it("effectiveLoginUrl null → NO navega (byte-equivalente histórico)", async () => {
    const page = mkPage();
    await expect(new ScraperService().performLogin(page as any, provider as any, null, onLog, null)).rejects.toThrow();
    expect(page.goto).not.toHaveBeenCalled();
  });
  it("caller de 4 args (recon) → effectiveLoginUrl undefined → NO navega", async () => {
    const page = mkPage();
    await expect((new ScraperService().performLogin as any)(page, provider, null, onLog)).rejects.toThrow();
    expect(page.goto).not.toHaveBeenCalled();
  });
});
