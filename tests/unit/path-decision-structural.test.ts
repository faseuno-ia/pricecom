import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(process.cwd(), "worker/src/index.ts"), "utf8");
const firstIdx = (needle: string) => src.indexOf(needle);

// Predicado puro para la failure injection: ¿el guard/witness precede a TODA extracción?
function guardPrecedesExtraction(text: string): boolean {
  const guard = text.indexOf("selectAndGuardPath(");
  const woo = text.indexOf("extractWooStoreApi(");
  const scraper = text.indexOf("scraper.run(");
  if (guard < 0 || woo < 0 || scraper < 0) return false;
  return guard < woo && guard < scraper;
}

describe("2G-R9-PR2 · GUARD ESTRUCTURAL · decisión/guard/witness preceden al scraper (CI-enforced)", () => {
  it("CANARY_GUARD_PRECEDES_SCRAPER_CALL + PATH_DECISION_PRECEDES_SCRAPER_CALL", () => {
    const guard = firstIdx("selectAndGuardPath(");
    const witness = firstIdx("buildPathDecisionWitness(");
    const woo = firstIdx("extractWooStoreApi(");
    const scraper = firstIdx("scraper.run(");
    expect(guard).toBeGreaterThan(0);
    expect(witness).toBeGreaterThan(0);
    expect(woo).toBeGreaterThan(0);
    expect(scraper).toBeGreaterThan(0);
    // el guard (que incluye el throw del canary) y el witness van ANTES de cualquier extracción
    expect(guard).toBeLessThan(woo);
    expect(guard).toBeLessThan(scraper);
    expect(witness).toBeLessThan(woo);
    expect(witness).toBeLessThan(scraper);
    expect(guardPrecedesExtraction(src)).toBe(true);
  });

  it("SINGLE_PATH_DECISION_SITE · una sola evaluación; sin segunda condicional de selección de path", () => {
    expect((src.match(/selectAndGuardPath\(/g) ?? []).length).toBe(1);
    // decideExecutionPath NO se llama en index.ts (la única evaluación vive dentro de selectAndGuardPath)
    expect((src.match(/decideExecutionPath\(/g) ?? []).length).toBe(0);
    // la conjunción de path inline vieja (PARTIAL_COMMIT_SHADOW === "1" && … PRICE_ONLY && … SKU-first) ya no existe
    expect(src).not.toMatch(/PARTIAL_COMMIT_SHADOW === "1"\s*&&/);
    // el despacho del path consume decision.selectedPath (no re-evalúa)
    expect(src).toMatch(/decision\.selectedPath === "PARTIAL"/);
  });

  it("el canary NO se terminaliza con un UPDATE status='FAILED' ad-hoc (usa el catch fenced existente)", () => {
    // el guard lanza CanaryPreconditionError; no hay escritura directa de FAILED en el path de selección.
    expect(src).toContain("CANARY_MARKER");
    expect(src).not.toMatch(/status:\s*["']FAILED["']/); // markFailed vive en la cola, no inline
  });

  it("FAILURE INJECTION: si una extracción precediera al guard, el predicado da false (CI rojo)", () => {
    const reordered = 'products = await scraper.run({});\n const decision = await selectAndGuardPath({}); extractWooStoreApi({});';
    expect(guardPrecedesExtraction(reordered)).toBe(false);
    // forma correcta (guard primero) → true
    const correct = 'const decision = await selectAndGuardPath({}); if (x) extractWooStoreApi({}); else scraper.run({});';
    expect(guardPrecedesExtraction(correct)).toBe(true);
  });
});
