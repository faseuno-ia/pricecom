import { describe, it, expect } from "vitest";
import { resolveWriteOrchestrationMode, WriteOrchestrationModeError } from "../../lib/catalog/write-orchestration-mode";

describe("2G-R10-PR19 · resolveWriteOrchestrationMode (fail-loud, default LEGACY)", () => {
  it("D) provider sin el campo (null/undefined) → LEGACY (sin cambio de conducta)", () => {
    expect(resolveWriteOrchestrationMode(null)).toBe("LEGACY");
    expect(resolveWriteOrchestrationMode(undefined)).toBe("LEGACY");
  });
  it("blank/whitespace → LEGACY", () => {
    expect(resolveWriteOrchestrationMode("")).toBe("LEGACY");
    expect(resolveWriteOrchestrationMode("   ")).toBe("LEGACY");
  });
  it("'LEGACY' → LEGACY · 'GUARDED_PRICE_ONLY' → GUARDED_PRICE_ONLY (opt-in explícito)", () => {
    expect(resolveWriteOrchestrationMode("LEGACY")).toBe("LEGACY");
    expect(resolveWriteOrchestrationMode("GUARDED_PRICE_ONLY")).toBe("GUARDED_PRICE_ONLY");
  });
  it("E) valor inválido no vacío → THROW (nunca cae a un default en silencio)", () => {
    for (const bad of ["PARTIAL", "guarded_price_only", "PRICE_ONLY", "1", "true", "shadow", "Legacy"]) {
      expect(() => resolveWriteOrchestrationMode(bad), bad).toThrow(WriteOrchestrationModeError);
    }
  });
  it("whitespace alrededor de un valor válido → se tolera (trim, igual que resolveCatalogWriteMode)", () => {
    expect(resolveWriteOrchestrationMode(" GUARDED_PRICE_ONLY ")).toBe("GUARDED_PRICE_ONLY");
    expect(resolveWriteOrchestrationMode("  LEGACY  ")).toBe("LEGACY");
  });
  it("no-string no null/undefined → THROW", () => {
    expect(() => resolveWriteOrchestrationMode(1 as unknown)).toThrow(WriteOrchestrationModeError);
    expect(() => resolveWriteOrchestrationMode({} as unknown)).toThrow(WriteOrchestrationModeError);
  });
  it("el error no filtra secretos y nombra el field + rawValue", () => {
    try { resolveWriteOrchestrationMode("bogus"); } catch (e) {
      expect((e as WriteOrchestrationModeError).field).toBe("writeOrchestrationMode");
      expect((e as WriteOrchestrationModeError).message).toContain("bogus");
    }
  });
});
