// A3-P1-R1 — contrato fail-loud de resolveExtractionMode (autoridad in-situ) con
// WARNING_NORMALIZATION_DIRECTION = PROPERTY_ABSENT_UNIVERSAL: ningún retorno no-excepcional
// emite la clave `warning`. Ejecuta la función real; prueba ausencia por clave (no por valor
// undefined) y por AST sobre los return de la función. Más propagación estructural (§12).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { resolveExtractionMode } from "@/lib/scraper/tiendanube-sku-first";

describe("resolveExtractionMode — contrato fail-loud", () => {
  it("null → LEGACY, sin throw", () => expect(resolveExtractionMode(null).mode).toBe("LEGACY"));
  it("undefined → LEGACY, sin throw", () => expect(resolveExtractionMode(undefined).mode).toBe("LEGACY"));
  it('"" → LEGACY, sin throw', () => expect(resolveExtractionMode("").mode).toBe("LEGACY"));
  it('" " → LEGACY, sin throw', () => expect(resolveExtractionMode(" ").mode).toBe("LEGACY"));
  it('"\\t\\n" → LEGACY, sin throw', () => expect(resolveExtractionMode("\t\n").mode).toBe("LEGACY"));
  it("valor exacto → SKU-first, sin throw", () =>
    expect(resolveExtractionMode("TIENDANUBE_LS_VARIANTS_SKU_FIRST").mode).toBe("TIENDANUBE_LS_VARIANTS_SKU_FIRST"));
  it("string desconocido → throw con field + valor", () => {
    expect(() => resolveExtractionMode("SKU_FIRST")).toThrow(/field=extractionMode/);
    expect(() => resolveExtractionMode("SKU_FIRST")).toThrow(/SKU_FIRST/);
  });
  it('" VALOR " → throw, no normaliza, whitespace visible', () => {
    expect(() => resolveExtractionMode(" TIENDANUBE_LS_VARIANTS_SKU_FIRST ")).toThrow(
      /" TIENDANUBE_LS_VARIANTS_SKU_FIRST "/
    );
  });
  it("no-string (1, {}) → LEGACY sin clave warning, sin throw", () => {
    for (const v of [1, {}] as unknown[]) {
      const r = resolveExtractionMode(v);
      expect(r).toStrictEqual({ mode: "LEGACY" });
      expect("warning" in r).toBe(false);
    }
  });
});

// §9.1 — matriz iterativa: para TODO retorno no-excepcional la clave `warning` está ausente.
// Autoridad = ausencia de clave (`in` + hasOwnProperty), NO valor undefined (toEqual/toBeUndefined
// pasarían incluso con { warning: undefined } presente).
describe("§8/§9.1 — ausencia real de la clave warning (matriz completa)", () => {
  const nonThrowing: Array<{ label: string; input: unknown; mode: string }> = [
    { label: "null", input: null, mode: "LEGACY" },
    { label: "undefined", input: undefined, mode: "LEGACY" },
    { label: '""', input: "", mode: "LEGACY" },
    { label: '" "', input: " ", mode: "LEGACY" },
    { label: "whitespace", input: "\t\n", mode: "LEGACY" },
    { label: "exacto", input: "TIENDANUBE_LS_VARIANTS_SKU_FIRST", mode: "TIENDANUBE_LS_VARIANTS_SKU_FIRST" },
    { label: "number 1", input: 1, mode: "LEGACY" },
    { label: "object {}", input: {}, mode: "LEGACY" },
  ];
  for (const c of nonThrowing) {
    it(`${c.label} → mode ${c.mode}, "warning" in result === false`, () => {
      const r = resolveExtractionMode(c.input);
      expect(r.mode).toBe(c.mode);
      expect("warning" in r).toBe(false);
      expect(Object.prototype.hasOwnProperty.call(r, "warning")).toBe(false);
      expect(r).toStrictEqual({ mode: c.mode });
    });
  }
});

// §9.2 — AST: ningún `return` de resolveExtractionMode contiene un object literal con propiedad
// `warning`. Localiza la función por símbolo; ignora comentarios y el tipo de retorno; los throws
// no son returns. No usa source.includes como autoridad.
describe("§9.2 — AST: los return de resolveExtractionMode no emiten la propiedad warning", () => {
  it("ningún return literal contiene la key warning", () => {
    const file = resolve(process.cwd(), "lib/scraper/tiendanube-sku-first.ts");
    const sf = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    let fn: ts.FunctionDeclaration | undefined;
    const findFn = (n: ts.Node) => {
      if (ts.isFunctionDeclaration(n) && n.name?.text === "resolveExtractionMode") fn = n;
      else ts.forEachChild(n, findFn);
    };
    findFn(sf);
    expect(fn, "resolveExtractionMode no encontrada").toBeDefined();
    const offenders: string[] = [];
    const visit = (n: ts.Node) => {
      if (ts.isReturnStatement(n) && n.expression && ts.isObjectLiteralExpression(n.expression)) {
        for (const p of n.expression.properties) {
          const nm = p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : undefined;
          if (nm === "warning") offenders.push(n.getText(sf));
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(fn!);
    expect(offenders).toEqual([]);
  });
});

// §12 — propagación del throw (estructural: no swallow / no degradación a legacy).
describe("§12 — propagación del throw", () => {
  const root = process.cwd();
  it("scraper.service.run(): dispatch en try/finally, sin catch que degrade a legacy", () => {
    const src = readFileSync(resolve(root, "lib/scraper/scraper.service.ts"), "utf8");
    expect(src).toMatch(/resolveExtractionMode\(options\.extractionMode\)/);
    expect(src).not.toMatch(/catch[\s\S]{0,80}mode\s*=\s*["']LEGACY["']/);
  });
  it("worker: el catch de processJob convierte errores en fallo de job (markFailed)", () => {
    const src = readFileSync(resolve(root, "worker/src/index.ts"), "utf8");
    expect(src).toMatch(/catch/);
    expect(src).toMatch(/markFailed/);
  });
});
