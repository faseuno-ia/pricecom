import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { startupSurfaceReferencesWorkerLoop, startupSurfaceReferencesDevEntrypoint } from "../../worker/src/topology-guard";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

// Descubrimiento DINÁMICO de superficies de arranque versionadas (no una lista de nombres). Cualquier
// Dockerfile*/Procfile*/railway.{json,toml}/nixpacks.toml NUEVO que se trackee mañana entra
// automáticamente a este conjunto → CI lo inspecciona sin editar este test.
function trackedFiles(): string[] {
  return execSync("git ls-files", { cwd: root }).toString().split(/\r?\n/).filter(Boolean);
}
function discoverStartupSurfaces(): string[] {
  return trackedFiles().filter((f) =>
    /(^|\/)Dockerfile(\.[^/]+)?$/.test(f) ||
    /(^|\/)Procfile(\.[^/]+)?$/.test(f) ||
    /(^|\/)railway\.(json|toml)$/.test(f) ||
    /(^|\/)nixpacks\.toml$/.test(f),
  );
}
// El servicio WEB se construye desde las superficies de la RAÍZ; el worker desde las de `worker/`.
const isWorkerSurface = (f: string) => f.startsWith("worker/");

describe("2G-R9-PR1 · GUARD 1 · el servicio web no arranca NINGÚN entrypoint del worker (dinámico, CI-enforced)", () => {
  const surfaces = discoverStartupSurfaces();
  const webSurfaces = surfaces.filter((f) => !isWorkerSurface(f));
  const workerSurfaces = surfaces.filter(isWorkerSurface);

  it("descubre dinámicamente las superficies de arranque (al menos root Dockerfile + worker/Dockerfile)", () => {
    expect(surfaces).toContain("Dockerfile");
    expect(surfaces).toContain("worker/Dockerfile");
    expect(webSurfaces.length).toBeGreaterThan(0);
    expect(workerSurfaces.length).toBeGreaterThan(0);
  });

  it("A) NINGUNA superficie de arranque WEB referencia un entrypoint del worker (worker/src/…)", () => {
    for (const f of webSurfaces) {
      expect(startupSurfaceReferencesWorkerLoop(read(f)), `web surface ${f} arranca un worker entrypoint`).toBe(false);
    }
    // el root Dockerfile sigue arrancando la web preservando el modelo de proceso previo (PID1=sh).
    expect(read("Dockerfile")).toMatch(/CMD\s*\[\s*"sh"\s*,\s*"-c"\s*,\s*"npm start"\s*\]/);
  });

  it("package.json: los scripts que USA el deploy (start, build) no referencian worker/src/", () => {
    const scripts = JSON.parse(read("package.json")).scripts ?? {};
    for (const key of ["start", "build"]) {
      expect(startupSurfaceReferencesWorkerLoop(String(scripts[key] ?? "")), `deploy script ${key}`).toBe(false);
    }
    expect(String(scripts.start)).toContain("next start");
  });

  it("las superficies del WORKER usan el entrypoint prod-faithful (index.ts) y NUNCA el dev (dev.ts fuerza WORKER_ENABLED=true)", () => {
    for (const f of workerSurfaces) {
      const c = read(f);
      if (startupSurfaceReferencesWorkerLoop(c)) {
        expect(startupSurfaceReferencesDevEntrypoint(c), `worker surface ${f} arranca dev.ts (neutralizaría el fail-closed)`).toBe(false);
      }
    }
    // worker/Dockerfile arranca index.ts explícitamente.
    expect(read("worker/Dockerfile")).toMatch(/worker\/src\/index\.ts/);
    expect(read("worker/Dockerfile")).not.toMatch(/ENV\s+WORKER_ENABLED/); // el flag no se hornea en la imagen
  });

  it("I) failure injection: reintroducir CUALQUIER worker entrypoint en una superficie → predicado true", () => {
    // sidecar viejo (index):
    expect(startupSurfaceReferencesWorkerLoop('CMD ["sh","-c","npx tsx worker/src/index.ts & npm start"]')).toBe(true);
    // entrypoint de DEV (bypass del fail-closed) — DEBE detectarse igual:
    expect(startupSurfaceReferencesWorkerLoop('CMD ["sh","-c","npx tsx worker/src/dev.ts & npm start"]')).toBe(true);
    expect(startupSurfaceReferencesDevEntrypoint("npx tsx worker/src/dev.ts")).toBe(true);
    // wrapper futuro cualquiera bajo worker/src/:
    expect(startupSurfaceReferencesWorkerLoop("startCommand = 'tsx worker/src/boot-hack'")).toBe(true);
    // forma web correcta NO dispara:
    expect(startupSurfaceReferencesWorkerLoop('CMD ["sh", "-c", "npm start"]')).toBe(false);
    expect(startupSurfaceReferencesWorkerLoop("next start")).toBe(false);
  });
});

describe("2G-R9-PR1 · GUARD 2 · worker entrypoint fail-closed (CI-enforced)", () => {
  const src = read("worker/src/index.ts");

  it("el arranque pasa por bootWorker (guard WORKER_ENABLED), no por un pollLoop() incondicional", () => {
    expect(src).toMatch(/bootWorker\(\{/);
    expect(src).toContain("process.env.WORKER_ENABLED");
    // NEON-GATE2A-EXEC-2 · pollLoop dejó de existir: el ejecutor ahora es startWakeExecutor o,
    // con el interruptor de migración, startLegacyFallbackExecutor. El guard NO se relaja — se
    // reexpresa sobre la propiedad que protegía: NINGÚN ejecutor puede arrancar fuera del closure
    // startPoller que bootWorker invoca sólo con WORKER_ENABLED === "true".
    expect(src).not.toMatch(/pollLoop/);
    const EXECUTORS = ["startWakeExecutor", "startLegacyFallbackExecutor"];
    // Conteo por substring, NO con new RegExp(...) sobre strings: "\s" dentro de un string de JS
    // es "s", y una regex mal escapada haría pasar este guard por vacuidad.
    const countOf = (hay: string, needle: string) => hay.split(needle).length - 1;
    // Al borrar el encabezado de la declaración, `nombre(` queda sólo en los call sites.
    const callsOnly = src.replace(/function\s+start\w*Executor/g, "DECLARATION");
    const startPollerAt = callsOnly.indexOf("startPoller:");
    expect(startPollerAt).toBeGreaterThan(-1);
    for (const fn of EXECUTORS) {
      expect(countOf(src, "function " + fn)).toBe(1);
      expect(countOf(callsOnly, fn + "(")).toBe(1);
      expect(countOf(callsOnly, "." + fn + "(")).toBe(0);
      // La única invocación vive DESPUÉS de startPoller:, es decir dentro del closure que
      // bootWorker ejecuta sólo con WORKER_ENABLED === "true".
      expect(callsOnly.indexOf(fn + "(")).toBeGreaterThan(startPollerAt);
    }
    // el closure elige entre los dos ejecutores y no hace nada más
    expect(src).toMatch(/startPoller:\s*\(\)\s*=>\s*\{\s*if \(LEGACY_POLL_FALLBACK\) startLegacyFallbackExecutor\(\);\s*else startWakeExecutor\(\);\s*\}/);
  });

  it("dev.ts (entrypoint local) fuerza WORKER_ENABLED sólo por defecto y delega en index.ts (mismo guard)", () => {
    const dev = read("worker/src/dev.ts");
    expect(dev).toMatch(/process\.env\.WORKER_ENABLED\s*=\s*process\.env\.WORKER_ENABLED\s*\?\?\s*"true"/); // respeta un valor explícito
    expect(dev).toMatch(/import\(["']\.\/index["']\)/); // reusa el guard de index.ts, no un pollLoop propio
    expect(dev).not.toMatch(/pollLoop/); // dev.ts no invoca pollLoop directamente
  });
});
