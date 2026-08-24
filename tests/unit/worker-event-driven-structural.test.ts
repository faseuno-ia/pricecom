// NEON-GATE2A-EXEC-2 · CLASE: STRUCTURAL
//
// Estos tests no ejercitan comportamiento: fijan la FORMA del worker para que la propiedad que
// habilita el autosuspend de Neon —"sin trabajo en vuelo, cero actividad periódica"— no se pierda
// por una reintroducción distraída. Un bucle o un timer que consulte la DB fuera de un job
// mantiene la conexión viva y devuelve el costo, sin romper ningún test de comportamiento.
//
// DISCIPLINA DE CONTEO: se cuenta sobre CÓDIGO, nunca sobre el texto crudo. El JSDoc de
// db-polling-queue.ts transcribe la query del claim, así que `FOR UPDATE SKIP LOCKED` aparece 3
// veces en el archivo y sólo 2 son código. Documentar lo que se eliminó no puede volver a poner
// un test en rojo.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";

const ROOT = process.cwd();

/** Quita comentarios de bloque y de línea antes de contar. */
function codeOnly(rel: string): string {
  return readFileSync(resolve(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}

/**
 * NEON-GATE2A-EXEC-2 · REVIEW R-6 · escáner de call sites productivos.
 *
 * Corpus: app/ lib/ worker/ scripts/ — SIN tests/. Un test que se cuente a sí mismo como caller
 * productivo convierte su propia existencia en la prueba de lo contrario de lo que afirma.
 */
const PRODUCTION_ROOTS = ["app", "lib", "worker", "scripts"];
const SKIP_DIRS = new Set(["node_modules", ".next", "dist", "build", "tests", "__tests__"]);

function collectProductionSources(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|tsx)$/.test(entry) && !/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
    }
  };
  for (const root of PRODUCTION_ROOTS) walk(resolve(ROOT, root));
  return out;
}

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

interface Occurrences {
  calls: { file: string; line: number; text: string }[];
  declarations: { file: string; line: number; text: string }[];
}

/**
 * Separa INVOCACIÓN de DECLARACIÓN sin construir regex desde strings: `new RegExp("\s" + n)`
 * colapsa a "s" en un string de JS y el escáner devolvería 0 por vacuidad, que es justo el modo
 * de fallo que este test existe para impedir. Con un identificador plano alcanzan predicados de
 * string, y son auditables a simple vista.
 */
function findOccurrences(files: string[], name: string): Occurrences {
  const needle = name + "(";
  const res: Occurrences = { calls: [], declarations: [] };
  for (const file of files) {
    const lines = stripComments(readFileSync(file, "utf8")).split("\n");
    lines.forEach((raw, i) => {
      if (!raw.includes(needle)) return;
      const t = raw.trim();
      const isImpl = t.startsWith("async " + needle) || t.startsWith("function " + needle);
      // Miembro de interface: `nombre(args): Tipo;` — declara, no invoca.
      const isMember = t.startsWith(needle) && t.endsWith(";");
      // String.fromCharCode(92) = backslash: evita pelearse con el escapado de una regex literal.
      const rel = file.slice(ROOT.length + 1).split(String.fromCharCode(92)).join("/");
      if (isImpl || isMember) res.declarations.push({ file: rel, line: i + 1, text: t });
      else res.calls.push({ file: rel, line: i + 1, text: t });
    });
  }
  return res;
}

describe("NEON-GATE2A-EXEC-2 · STRUCTURAL · forma del worker event-driven", () => {
  it("no_while_true_in_worker_entrypoint", () => {
    const src = codeOnly("worker/src/index.ts");

    // Control positivo del filtro: si codeOnly estuviera devolviendo vacío o algo que no es el
    // entrypoint, las tres afirmaciones de abajo pasarían por vacuidad.
    expect(src).toContain("async function processJob");
    expect(src.length).toBeGreaterThan(5000);

    expect(src).not.toMatch(/while\s*\(\s*true\s*\)/);

    // `for (;;)` es el mismo bucle con otra cara: se admite UNO y sólo dentro del fallback legacy.
    const loops = src.match(/for\s*\(\s*;\s*;\s*\)/g) ?? [];
    expect(loops).toHaveLength(1);
    const fallbackAt = src.indexOf("function startLegacyFallbackExecutor");
    expect(fallbackAt).toBeGreaterThan(-1);
    expect(src.search(/for\s*\(\s*;\s*;\s*\)/)).toBeGreaterThan(fallbackAt);
  });

  it("no_setinterval_touching_db_outside_job", () => {
    // Sólo dos archivos del worker programan timers periódicos.
    const index = codeOnly("worker/src/index.ts");
    const lease = codeOnly("worker/src/job-lease.ts");

    // (a) En el entrypoint hay exactamente un setInterval y es el heartbeat de worker DESHABILITADO:
    //     imprime por consola y no toca prisma ni la cola.
    const intervals = index.match(/setInterval\s*\(/g) ?? [];
    expect(intervals).toHaveLength(1);
    const line = index
      .split("\n")
      .find((l) => /setInterval\s*\(/.test(l))!;
    expect(line).toContain("scheduleDisabledHeartbeat");
    expect(line).not.toMatch(/prisma|queue\./);

    // (b) El otro timer es el heartbeat de lease, que por definición sólo existe mientras hay un
    //     job en vuelo: se instancia dentro de processJob y se detiene en su finally.
    expect(lease).toMatch(/setInterval\s*\(/);
    const news = index.match(/new JobLease\(/g) ?? [];
    expect(news).toHaveLength(1);
    const processJobAt = index.indexOf("async function processJob");
    expect(index.indexOf("new JobLease(")).toBeGreaterThan(processJobAt);
    expect(index).toMatch(/lease\.stop\("processJob-end"\)/);

    // (c) Los barridos periódicos globales pierden su call site en producción.
    expect(index).not.toMatch(/releaseStaleJobs\s*\(/);
    expect(index).not.toMatch(/runConsistencyCheck\s*\(/);
  });

  it("wake_response_literals_match_wake_client_contract", async () => {
    // Los dos lados del contrato son repos distintos del mismo deploy y NO comparten módulo: el
    // worker no puede importar de `@/lib` y el web no puede importar de `worker/`. Si divergen,
    // no hay error de tipos ni HTTP fallido — el emisor degrada TODO a UNRECOGNIZED_RESPONSE y el
    // wake queda mudo. Este test es lo único que ata las dos listas.
    const { WAKE_RESPONSE_OUTCOMES, WAKE_SECRET_HEADER: workerHeader } = await import(
      "../../worker/src/wake-contract"
    );
    const { WORKER_2XX_OUTCOMES, WAKE_SECRET_HEADER: webHeader } = await import(
      "../../lib/worker/wake-client"
    );

    expect(new Set(WAKE_RESPONSE_OUTCOMES)).toEqual(new Set(WORKER_2XX_OUTCOMES));
    expect(WAKE_RESPONSE_OUTCOMES).toHaveLength(WORKER_2XX_OUTCOMES.size);
    expect(workerHeader).toBe(webHeader);

    // Control negativo: la igualdad de arriba no debe poder satisfacerse con conjuntos vacíos.
    expect(WORKER_2XX_OUTCOMES.size).toBe(6);
  });

  it("release_stale_job_singular_has_exactly_one_production_call_site", () => {
    const files = collectProductionSources();

    // ── Anti-vacuidad 1 · el corpus existe ────────────────────────────────────────────
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith("db-polling-queue.ts"))).toBe(true);
    expect(files.every((f) => !f.includes("tests"))).toBe(true);

    // ── Anti-vacuidad 2 · el escáner ENCUENTRA llamadas cuando existen ────────────────
    const claim = findOccurrences(files, "claimJob");
    expect(claim.calls.length).toBeGreaterThanOrEqual(3);
    expect(claim.declarations.length).toBeGreaterThan(0);

    // ── ONE_WAKE = ONE_ATTEMPT, fijado estructuralmente ──────────────────────────────
    // El handler tiene DOS call sites de claimJob y no puede tener un tercero: el directo y el
    // único reintento posterior al release. Un bucle release → claim → release → claim se vería
    // acá antes que en ningún test de comportamiento.
    expect(claim.calls.filter((c) => c.file === "worker/src/wake-server.ts")).toHaveLength(2);

    // ── SINGULAR · de CERO a UNO, y en el camino del wake handler ────────────────────
    //
    // El hallazgo F1 fue exactamente esto: la función existía, la interface la declaraba y la
    // integración la probaba — y nadie la llamaba. Función existente ≠ capacidad existente. Por
    // eso el guard no cuenta ocurrencias sueltas: exige que el caller esté EN EL CAMINO que
    // recorre un wake.
    const singular = findOccurrences(files, "releaseStaleJob");
    const onWakePath = singular.calls.filter((c) => c.file === "worker/src/wake-server.ts");
    expect(onWakePath).toHaveLength(1);
    expect(onWakePath[0].text).toContain("deps.releaseStaleJob(");

    // Las demás ocurrencias sólo pueden ser INYECCIÓN de la dependencia en el entrypoint (una por
    // ejecutor). No son puntos de decisión: no eligen liberar nada, sólo cablean el método.
    const wiring = singular.calls.filter((c) => c.file !== "worker/src/wake-server.ts");
    expect(wiring.every((c) => c.file === "worker/src/index.ts")).toBe(true);
    expect(wiring.every((c) => c.text.startsWith("releaseStaleJob: ("))).toBe(true);

    // ── PLURAL · sigue en CERO · esta mitad no cambia ────────────────────────────────
    //
    // El barrido GLOBAL murió con el poll loop. Reactivarlo devuelve el drain de trabajo
    // abandonado (GLOBAL_DRAIN_ALLOWED=false) y nulea startedAt/errorMessage, que es la evidencia
    // que distingue un job interrumpido de uno que nunca arrancó.
    const plural = findOccurrences(files, "releaseStaleJobs");
    expect(plural.declarations.length).toBeGreaterThanOrEqual(2); // impl + firma de interface
    expect(plural.calls).toEqual([]);
  });
});
