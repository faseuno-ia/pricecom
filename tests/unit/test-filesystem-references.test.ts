// G1 (2A-R1) — GUARD PERMANENTE de referencias filesystem en tests.
//
// Todo test commiteado que lea un archivo del repo por un path ESTÁTICO debe referenciar
// un archivo TRACKED por Git. Que exista en el working tree (untracked local) NO alcanza:
// el checkout limpio de CI solo tiene lo trackeado. Este guard existe porque dos tests
// A41-entangled leían scripts/_a41-recon.ts y lib/ops/a41-document-redirect-login.ts
// (excluidos del commit) → ENOENT en CI. Falla con test, línea y path.
//
// Analizador: AST de TypeScript intrafile y bounded (no interprocedural general). Detecta:
//   1) lectura directa con literal;           2) lectura con resolve/join;
//   3) lectura con constante local;            4) wrapper local de 1 nivel (p.ej. sha256File(path)).
// Ignora: comentarios, strings de mensajes/expect, URLs, paths dinámicos no resolubles.
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as ts from "typescript";

const ROOT = process.cwd();

const FS_READ_FUNCS = new Set([
  "readFileSync", "readFile", "existsSync", "statSync", "lstatSync", "accessSync", "createReadStream",
]);
const PATH_JOINERS = new Set(["resolve", "join"]); // resolve/join o path.resolve/path.join
const ROOT_MARKERS = new Set(["root", "ROOT", "__dirname"]); // identificadores base del repo (se descartan)

// Excepción explícita y ESTRECHA: .env.test es un archivo de entorno gitignored por diseño
// (lo escribe ci.yml contra el Postgres efímero; nunca se commitea). No es un source del repo.
// Cualquier otra excepción futura debe agregarse acá, comentada, bajo decisión separada.
const KNOWN_UNTRACKED_ALLOWLIST = new Set([".env.test"]);

interface FsRef { line: number; callKind: string; path: string; }

const calleeName = (n: ts.CallExpression): string | null =>
  ts.isIdentifier(n.expression) ? n.expression.text
    : ts.isPropertyAccessExpression(n.expression) ? n.expression.name.text : null;

const isCwdCall = (n: ts.Node): boolean =>
  ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === "cwd";

function isRepoInternalFilePath(p: string): boolean {
  if (/^https?:\/\//i.test(p)) return false;        // URL
  if (/^[A-Za-z]:[\\/]/.test(p)) return false;       // C:\...
  if (p.startsWith("/")) return false;               // absoluto POSIX
  if (!/\.[a-z0-9]+$/i.test(p.split("/").pop() || "")) return false; // sin extensión → probable dir
  return true;
}
const normalize = (p: string): string => p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");

export function analyzeFsRefs(sourceText: string, fileName = "synthetic.ts"): FsRef[] {
  const sf = ts.createSourceFile(fileName, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const constPaths = new Map<string, string>();  // const → path estático repo-relativo
  const wrappers = new Map<string, number>();     // wrapper → índice de parámetro que es el path

  function resolveStatic(node: ts.Node | undefined): string | null {
    if (!node) return null;
    if (ts.isStringLiteralLike(node)) return node.text;
    if (ts.isIdentifier(node)) return constPaths.get(node.text) ?? null;
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      if (name && PATH_JOINERS.has(name)) {
        const parts: string[] = [];
        for (const arg of node.arguments) {
          if (ts.isIdentifier(arg) && ROOT_MARKERS.has(arg.text)) continue; // base del repo
          if (isCwdCall(arg)) continue;
          const r = resolveStatic(arg);
          if (r === null) return null;
          parts.push(r);
        }
        return parts.length ? parts.join("/") : null;
      }
    }
    return null;
  }

  // índice del parámetro usado como path en un FS_READ dentro del cuerpo de la función (o null)
  function paramPathIndex(body: ts.Node, params: string[]): number | null {
    let found: number | null = null;
    const paramIdxInArg = (arg: ts.Node): number | null => {
      if (ts.isIdentifier(arg)) { const i = params.indexOf(arg.text); return i >= 0 ? i : null; }
      if (ts.isCallExpression(arg)) for (const a of arg.arguments) { const i = paramIdxInArg(a); if (i !== null) return i; }
      return null;
    };
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n)) {
        const name = calleeName(n);
        if (name && FS_READ_FUNCS.has(name) && n.arguments.length) {
          const i = paramIdxInArg(n.arguments[0]);
          if (i !== null) found = i;
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(body);
    return found;
  }

  // Pass 1: consts con path estático + wrappers de lectura.
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const p = resolveStatic(n.initializer);
      if (p !== null) constPaths.set(n.name.text, p);
      if (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer)) {
        const params = n.initializer.parameters.map((pp) => (ts.isIdentifier(pp.name) ? pp.name.text : ""));
        const idx = paramPathIndex(n.initializer.body, params);
        if (idx !== null) wrappers.set(n.name.text, idx);
      }
    }
    if (ts.isFunctionDeclaration(n) && n.name && n.body) {
      const params = n.parameters.map((pp) => (ts.isIdentifier(pp.name) ? pp.name.text : ""));
      const idx = paramPathIndex(n.body, params);
      if (idx !== null) wrappers.set(n.name.text, idx);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);

  // Pass 2: llamadas FS directas + llamadas a wrappers con path estático.
  const refs: FsRef[] = [];
  const push = (node: ts.Node, kind: string, raw: string) => {
    const p = normalize(raw);
    if (!isRepoInternalFilePath(p)) return;
    const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;
    refs.push({ line, callKind: kind, path: p });
  };
  const scan = (n: ts.Node) => {
    if (ts.isCallExpression(n)) {
      const name = calleeName(n);
      if (name && FS_READ_FUNCS.has(name) && n.arguments.length) {
        const p = resolveStatic(n.arguments[0]);
        if (p !== null) push(n, name, p);
      } else if (name && wrappers.has(name)) {
        const idx = wrappers.get(name)!;
        const p = resolveStatic(n.arguments[idx]);
        if (p !== null) push(n, name + "()", p);
      }
    }
    ts.forEachChild(n, scan);
  };
  scan(sf);
  return refs;
}

function trackedFiles(): Set<string> {
  const out = execFileSync("git", ["ls-files", "-z"], { cwd: ROOT, encoding: "utf8" });
  return new Set(out.split("\0").filter(Boolean).map((f) => f.replace(/\\/g, "/")));
}

describe("guard filesystem — self-tests del analizador (debe poder fallar)", () => {
  it("A · lectura directa con literal", () => {
    const r = analyzeFsRefs('readFileSync("lib/tracked.ts")');
    expect(r).toEqual([{ line: 1, callKind: "readFileSync", path: "lib/tracked.ts" }]);
  });
  it("B · lectura con resolve(ROOT, literal)", () => {
    const r = analyzeFsRefs('existsSync(resolve(ROOT, "lib/untracked.ts"))');
    expect(r.map((x) => x.path)).toEqual(["lib/untracked.ts"]);
  });
  it("C · wrapper local de 1 nivel + const path", () => {
    const src = `const sha256File = (p) => readFileSync(p);\nconst TARGET = resolve(ROOT, "lib/untracked.ts");\nsha256File(TARGET);`;
    const r = analyzeFsRefs(src);
    expect(r.some((x) => x.path === "lib/untracked.ts" && x.callKind === "sha256File()")).toBe(true);
  });
  it("D · ignora strings que no son argumentos de filesystem", () => {
    const src = `// readFileSync("lib/comment.ts")\nconst x = "lib/untracked.ts";\nexpect(x).toBe("lib/untracked.ts");`;
    expect(analyzeFsRefs(src)).toEqual([]);
  });
  it("E · control negativo: detecta y puede marcar untracked (line+path+kind)", () => {
    const refs = analyzeFsRefs('readFileSync("lib/ops/a41-x.ts")');
    const fakeTracked = new Set(["lib/other.ts"]);
    const violations = refs.filter((x) => !fakeTracked.has(x.path));
    expect(violations.length).toBe(1);
    expect(violations[0]).toMatchObject({ line: 1, callKind: "readFileSync", path: "lib/ops/a41-x.ts" });
  });
});

describe("guard filesystem — escaneo real de tests trackeados", () => {
  const tracked = trackedFiles();
  const testFiles = [...tracked].filter((f) => f.startsWith("tests/") && (f.endsWith(".ts") || f.endsWith(".tsx")));

  it("TRACKED_FILE_SOURCE = git ls-files (hay tests trackeados)", () => {
    expect(testFiles.length).toBeGreaterThan(0);
  });

  it("TEST_FILESYSTEM_REFERENCES_TO_UNTRACKED_PATHS = 0", () => {
    const violations: string[] = [];
    for (const tf of testFiles) {
      const src = readFileSync(resolve(ROOT, tf), "utf8");
      for (const ref of analyzeFsRefs(src, tf)) {
        if (tracked.has(ref.path)) continue;
        if (KNOWN_UNTRACKED_ALLOWLIST.has(ref.path)) continue;
        violations.push(`UNTRACKED_TEST_FILESYSTEM_REFERENCE:\n${tf}:${ref.line}\n${ref.callKind} → ${ref.path}`);
      }
    }
    expect(violations).toEqual([]);
  });
});
