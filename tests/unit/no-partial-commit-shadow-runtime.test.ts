import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";

// 2G-R10-PR19 · GUARD DE CI · el flag global muerto PARTIAL_COMMIT_SHADOW no puede reintroducirse en
// CÓDIGO EJECUTABLE/PRODUCTIVO. Alcance: worker/src, lib, app (tracked .ts/.tsx). EXCLUYE documentación
// (docs/ debe seguir mencionándolo como evidencia del incidente) y los archivos de test (que lo nombran
// para vigilarlo). El nombre se compone en runtime para que ESTE archivo no se auto-detecte.
const root = process.cwd();
const FLAG = ["PARTIAL", "COMMIT", "SHADOW"].join("_");

function grepRuntime(pattern: string): string[] {
  // git grep sobre superficies ejecutables tracked; excluye tests y docs. Devuelve [] si no hay match.
  try {
    const out = execSync(
      `git grep -n -- "${pattern}" -- "worker/src/**/*.ts" "lib/**/*.ts" "app/**/*.ts" "app/**/*.tsx"`,
      { cwd: root, stdio: ["ignore", "pipe", "ignore"] },
    ).toString();
    return out.split(/\r?\n/).filter(Boolean).filter((l) => !/(^|\/)tests\//.test(l) && !/\.test\.ts/.test(l));
  } catch {
    return []; // git grep exit 1 = sin matches
  }
}

describe("2G-R10-PR19 · GUARD · cero referencias runtime a PARTIAL_COMMIT_SHADOW (CI-enforced)", () => {
  it("no hay lectura/uso del flag en código ejecutable (worker/src, lib, app)", () => {
    const hits = grepRuntime(FLAG);
    expect(hits, `referencias runtime al flag muerto:\n${hits.join("\n")}`).toEqual([]);
  });

  it("no hay lectura de process.env.<flag> en ninguna parte del código ejecutable", () => {
    const hits = grepRuntime(`process.env.${FLAG}`);
    expect(hits).toEqual([]);
  });

  it("el patrón del guard SÍ detectaría una reintroducción (sanity de la herramienta)", () => {
    // git grep del propio nombre del flag encuentra al menos las menciones en tests/docs (existen),
    // probando que el mecanismo de búsqueda funciona y que el [] de arriba es real, no un falso vacío.
    const anywhere = (() => { try { return execSync(`git grep -lc -- "${FLAG}"`, { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString(); } catch { return ""; } })();
    expect(anywhere.length).toBeGreaterThan(0); // docs/tests lo mencionan → la herramienta ve el string
  });
});
