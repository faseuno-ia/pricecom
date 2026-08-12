import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { startupSurfaceReferencesWorkerLoop } from "../../worker/src/topology-guard";

const root = process.cwd();
const read = (p: string) => readFileSync(resolve(root, p), "utf8");

// GUARD 1 · Ninguna superficie de arranque del SERVICIO WEB puede referenciar el entrypoint del worker.
// Cubre TODAS las superficies versionadas de arranque del web (Dockerfile CMD/ENTRYPOINT, railway
// startCommand, Procfile, npm start, nixpacks). Reintroducir el sidecar en cualquiera → CI ROJO.
describe("2G-R9-PR1 · GUARD 1 · el servicio web no arranca el worker (dual-poller CI-enforced)", () => {
  it("A) el Dockerfile raíz NO arranca worker/src/index como sidecar", () => {
    const df = read("Dockerfile");
    expect(startupSurfaceReferencesWorkerLoop(df)).toBe(false);
    expect(df).not.toMatch(/worker\/src\/index/);
    // sigue arrancando la web (npm start = prisma migrate deploy && next start)
    expect(df).toMatch(/CMD\s*\[\s*"npm"\s*,\s*"start"\s*\]/);
  });

  it("railway.json (web) no define un startCommand que arranque el worker", () => {
    const rj = read("railway.json");
    expect(startupSurfaceReferencesWorkerLoop(rj)).toBe(false);
    const parsed = JSON.parse(rj);
    const startCmd = parsed?.deploy?.startCommand ?? "";
    expect(startupSurfaceReferencesWorkerLoop(String(startCmd))).toBe(false);
  });

  it("package.json 'start' (script de deploy del web) no referencia el worker", () => {
    const startScript = JSON.parse(read("package.json")).scripts?.start ?? "";
    expect(startupSurfaceReferencesWorkerLoop(startScript)).toBe(false);
    expect(startScript).toContain("next start");
  });

  it("no hay Procfile/nixpacks del web que arranque el worker", () => {
    for (const surface of ["Procfile", "nixpacks.toml", "Dockerfile.web"]) {
      if (existsSync(resolve(root, surface))) {
        expect(startupSurfaceReferencesWorkerLoop(read(surface))).toBe(false);
      }
    }
  });

  it("I) el predicado del guard DETECTA la reintroducción del sidecar (regresión → rojo)", () => {
    // Forma exacta del CMD viejo (causa raíz) y variantes:
    expect(startupSurfaceReferencesWorkerLoop('CMD ["sh","-c","npx tsx worker/src/index.ts & npm start"]')).toBe(true);
    expect(startupSurfaceReferencesWorkerLoop("startCommand = 'tsx worker/src/index'")).toBe(true);
    // La forma nueva del web NO dispara:
    expect(startupSurfaceReferencesWorkerLoop('CMD ["npm", "start"]')).toBe(false);
  });
});

// GUARD 2 · El entrypoint del worker conserva el guard fail-closed (no arranca el poller incondicional).
describe("2G-R9-PR1 · GUARD 2 · worker entrypoint fail-closed (CI-enforced)", () => {
  const src = read("worker/src/index.ts");

  it("el arranque pasa por bootWorker (guard WORKER_ENABLED), no por un pollLoop() incondicional", () => {
    expect(src).toMatch(/bootWorker\(\{/);
    expect(src).toContain("process.env.WORKER_ENABLED");
    // NO debe existir una invocación top-level incondicional `pollLoop();`
    expect(src).not.toMatch(/^\s*pollLoop\(\);\s*$/m);
    // La única invocación de pollLoop es dentro del closure startPoller (prefijada con void).
    const invocations = [...src.matchAll(/(^|[^a-zA-Z.])pollLoop\(\)/gm)]
      .filter((m) => !/function\s+pollLoop/.test(src.slice(Math.max(0, m.index! - 20), m.index! + 12)));
    // exactamente una invocación (el void pollLoop() del closure); la definición async no cuenta.
    expect(invocations.length).toBe(1);
    expect(src).toMatch(/startPoller:\s*\(\)\s*=>\s*\{\s*void pollLoop\(\);\s*\}/);
  });

  it("worker/Dockerfile arranca el entrypoint del worker (sin flag horneado → fail-closed por Railway)", () => {
    const wdf = read("worker/Dockerfile");
    expect(wdf).toMatch(/worker\/src\/index\.ts/);
    // El flag NO se hornea en la imagen: WORKER_ENABLED lo inyecta el servicio pricecom-worker (§8).
    expect(wdf).not.toMatch(/ENV\s+WORKER_ENABLED/);
  });
});
