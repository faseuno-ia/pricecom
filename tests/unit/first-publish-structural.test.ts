// C2-DESIGN-1 · Gate 2 · CLASE: STRUCTURAL
//
// Protege el CONTRATO, no una string. Cuatro cosas:
//   1. la identidad de un proveedor puede ser DATO de la autoridad, nunca RAMA de negocio
//   2. client.createProduct sigue teniendo un único call site productivo (si aparece otro, el
//      guard dejó de dominar y esto debe fallar)
//   3. integridad del seed, 100% offline (SEED_INTEGRITY_TEST_MODE = STRUCTURAL_OFFLINE)
//   4. stockSource no participa de la decisión de elegibilidad, ni estructural ni
//      conductualmente
//
// Lectura de archivos tracked con readFileSync, mismo patrón que
// tests/unit/catalog-write-mode-structural.test.ts. Cero DB.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";

vi.mock("@/lib/db/client", async () => {
  const { createFakePrisma } = await import("../helpers/fake-prisma");
  const client = createFakePrisma();
  return { prisma: client, default: client };
});

import { prisma as fakePrisma } from "@/lib/db/client";
import { loadFakeDb } from "../helpers/fake-prisma";
import { installWooFetchSpy, type FetchSpyHandle } from "../helpers/fetch-spy";
import {
  buildPublishFixture,
  CATALOG_PRODUCT_ID,
  PROVIDER_DT,
  PROVIDER_IMPOTEKNO,
  STORE_ID,
  STORE_URL,
} from "../helpers/first-publish-fixtures";
import { WooCommerceClient } from "@/lib/integrations/woocommerce/client";
import { publishProductToWoo } from "@/lib/integrations/woocommerce/publication-service";
import {
  canFirstPublish,
  FIRST_PUBLISH_AUTHORITY,
} from "@/lib/publishing/first-publish-authority";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(resolve(ROOT, rel), "utf8");

/** El ÚNICO archivo autorizado a contener identidades literales de provider/store. */
const AUTHORITY_MODULE = "lib/publishing/first-publish-authority.ts";

/** Lógica de negocio que participa del camino de publicación. */
const BUSINESS_LOGIC_FILES = [
  "lib/integrations/woocommerce/publication-service.ts",
  "lib/integrations/woocommerce/client.ts",
  "lib/catalog/upsert-catalog-products.ts",
  "app/api/catalog/bulk-update/route.ts",
  "app/api/my-store/sync/publications/route.ts",
  "app/api/catalog/publications/[id]/sku/route.ts",
];

/** Directorios de código productivo (excluye tests/ deliberadamente). */
const PRODUCTION_DIRS = ["lib", "app", "worker", "components", "scripts"];

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".next") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry)) out.push(full);
  }
  return out;
}

describe("C2-DESIGN-1 · STRUCTURAL", () => {
  it("no_provider_identity_in_business_logic", () => {
    // cuid = "c" + 24 alfanuméricos. Buscamos identidades como LITERAL entre comillas, que es
    // la forma en que se colaría una exclusión ad hoc.
    const quotedCuid = /["'`]c[a-z0-9]{24}["'`]/;

    for (const rel of BUSINESS_LOGIC_FILES) {
      const src = read(rel);
      // Comparaciones por nombre de proveedor: generaliza la intención de
      // tests/unit/catalog-write-mode-structural.test.ts:14, que hoy sólo veta el literal
      // "Different Touch".
      expect(src, `${rel}: comparación por provider.name`).not.toMatch(
        /provider\.name\s*===/,
      );
      expect(src, `${rel}: comparación por provider.id literal`).not.toMatch(
        /provider\.id\s*===\s*["'`]/,
      );
      expect(src, `${rel}: comparación por providerId literal`).not.toMatch(
        /providerId\s*===\s*["'`]/,
      );
      expect(src, `${rel}: comparación por store.id literal`).not.toMatch(
        /store\.id\s*===\s*["'`]/,
      );
      expect(src, `${rel}: comparación por storeId literal`).not.toMatch(
        /storeId\s*===\s*["'`]/,
      );
      // Ninguna identidad cuid embebida.
      expect(src, `${rel}: literal cuid embebido`).not.toMatch(quotedCuid);
    }

    // …y la autoridad SÍ las contiene (si no, el test de arriba sería vacuo).
    expect(read(AUTHORITY_MODULE)).toMatch(quotedCuid);
  });

  it("no_production_caller_injects_authority_lookup", () => {
    // El módulo documenta "producción usa el default"; este test lo convierte en garantía.
    //
    // DETECCIÓN POR BALANCEO DE DELIMITADORES, no por conteo de comas. Se recorre carácter a
    // carácter desde el "(" de la invocación: se ignoran las comas dentro de paréntesis,
    // corchetes o llaves anidados, y dentro de string/template literals; sólo cortan argumento
    // las comas de profundidad 0. Así:
    //   canFirstPublish(getIds(a, b), storeId)          -> 2 argumentos (contar comas daría 3)
    //   canFirstPublish(p, s, () => { throw new E() })  -> 3 argumentos
    // Los comentarios se eliminan antes de escanear para que una mención en prosa no cuente
    // como invocación, y la DECLARACIÓN de la función se descarta explícitamente.
    const stripComments = (src: string) =>
      src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

    // Carácter de escape sin escribir un backslash literal (evita ambigüedad de escapado).
    const BACKSLASH = String.fromCharCode(92);

    /** Cantidad de argumentos de TOP LEVEL de cada invocación de canFirstPublish. */
    function argCountsOf(src: string): number[] {
      const code = stripComments(src);
      const counts: number[] = [];
      const needle = /(^|[^\w$.])canFirstPublish\s*\(/g;
      let m: RegExpExecArray | null;
      while ((m = needle.exec(code)) !== null) {
        const upTo = code.slice(0, m.index + m[0].length);
        // `export function canFirstPublish(` es la definición, no una llamada.
        if (/\bfunction\s+canFirstPublish\s*\($/.test(upTo)) continue;

        let depth = 0;
        let args = 0;
        let sawContent = false;
        let quote: string | null = null;
        for (let i = m.index + m[0].length; i < code.length; i++) {
          const ch = code[i];
          if (quote !== null) {
            if (ch === BACKSLASH) i++;
            else if (ch === quote) quote = null;
            continue;
          }
          if (ch === '"' || ch === "'" || ch === "`") {
            quote = ch;
            sawContent = true;
            continue;
          }
          if (ch === "(" || ch === "[" || ch === "{") {
            depth++;
            sawContent = true;
            continue;
          }
          if (ch === ")" && depth === 0) {
            if (sawContent) args++;
            break;
          }
          if (ch === ")" || ch === "]" || ch === "}") {
            depth--;
            continue;
          }
          if (ch === "," && depth === 0) {
            args++;
            sawContent = false;
            continue;
          }
          if (ch.trim() !== "") sawContent = true;
        }
        counts.push(args);
      }
      return counts;
    }

    const corpus: { file: string; counts: number[] }[] = [];
    for (const dir of PRODUCTION_DIRS) {
      for (const file of walk(resolve(ROOT, dir))) {
        const counts = argCountsOf(readFileSync(file, "utf8"));
        if (counts.length > 0) {
          corpus.push({ file: file.split(sep).join("/"), counts });
        }
      }
    }

    // CONTROL POSITIVO (obligatorio): el mismo barrido tiene que ENCONTRAR las invocaciones de
    // DOS argumentos. Sin esto, un corpus vacío o un matcher roto harían pasar el test siempre.
    const twoArgCalls = corpus.flatMap((c) => c.counts.filter((n) => n === 2));
    expect(
      twoArgCalls.length,
      "control positivo vacío: el barrido no encontró NINGUNA invocación de 2 argumentos",
    ).toBeGreaterThan(0);
    expect(
      corpus.some(
        (c) =>
          c.file.endsWith("/lib/integrations/woocommerce/publication-service.ts") &&
          c.counts.filter((n) => n === 2).length === 1,
      ),
      "control positivo: no se encontró la invocación de 2 argumentos del gateway",
    ).toBe(true);

    // ASERCIÓN: ningún caller productivo inyecta el lookup (tercer argumento).
    const injected = corpus
      .filter((c) => c.counts.some((n) => n >= 3))
      .map((c) => `${c.file} (args: ${c.counts.join(", ")})`);
    expect(
      injected,
      `callers productivos con lookup inyectado: ${injected.join(" · ")}`,
    ).toEqual([]);
  });
  it("createProduct_has_exactly_one_production_call_site", () => {
    const callSites: string[] = [];
    for (const dir of PRODUCTION_DIRS) {
      for (const file of walk(resolve(ROOT, dir))) {
        const src = readFileSync(file, "utf8");
        if (/\.createProduct\s*\(/.test(src)) {
          callSites.push(file.replace(ROOT, "").replace(/\\/g, "/"));
        }
      }
    }
    expect(callSites).toHaveLength(1);
    expect(callSites[0]).toContain(
      "/lib/integrations/woocommerce/publication-service.ts",
    );
  });

  it("guard_runs_before_any_woo_interaction_in_the_gateway", () => {
    // Orden ESTRUCTURAL: el guard tiene que aparecer antes del GET de verificación de SKU y
    // antes de la creación remota. Si un refactor lo mueve más abajo, esto falla.
    const src = read("lib/integrations/woocommerce/publication-service.ts");
    const guardAt = src.indexOf("verdict = canFirstPublish(");
    const skuGuardAt = src.indexOf("assertSkuNotInWoo(");
    const createAt = src.indexOf("client.createProduct(");

    expect(guardAt).toBeGreaterThan(-1);
    expect(skuGuardAt).toBeGreaterThan(guardAt);
    expect(createAt).toBeGreaterThan(guardAt);
    // La invocación aparece una sola vez (no duplicada por copia).
    expect((src.match(/verdict = canFirstPublish\(/g) ?? []).length).toBe(1);
    // Y el gateway falla cerrado ante una autoridad que lance.
    expect(src).toMatch(/try\s*\{\s*verdict = canFirstPublish\(/);
    expect(src).toMatch(/reason: "AUTHORITY_ERROR"/);
  });

  it("seed_integrity", () => {
    const cuid = /^c[a-z0-9]{24}$/;
    const pairs = new Set<string>();

    for (const entry of FIRST_PUBLISH_AUTHORITY) {
      expect(entry.providerId, `providerId inválido: ${entry.providerId}`).toMatch(cuid);
      expect(entry.storeId, `storeId inválido: ${entry.storeId}`).toMatch(cuid);
      // Store única del sistema (ELECTROFAYS).
      expect(entry.storeId).toBe("cmpbws2z90001luzc2tsi5143");
      // reason obligatorio en ELIGIBLE e INELIGIBLE por igual.
      expect(entry.reason.trim().length).toBeGreaterThan(0);
      // Metadata humana presente (para que un typo de id se vea en review).
      expect(entry.providerName.trim().length).toBeGreaterThan(0);
      expect(entry.storeName.trim().length).toBeGreaterThan(0);
      expect(entry.baselineRemotePublications).toBeGreaterThanOrEqual(0);
      expect(entry.catalogProductsAtDecision).toBeGreaterThanOrEqual(0);

      const key = `${entry.providerId}::${entry.storeId}`;
      // Exactamente una decisión por par ⇒ no puede repetirse la clave.
      expect(pairs.has(key), `par duplicado: ${key}`).toBe(false);
      pairs.add(key);
    }

    // JUGUETES ELY y LEDMOMENTS comparten el prefijo cmqesu14 — no pueden colapsar.
    const ely = FIRST_PUBLISH_AUTHORITY.find((e) => e.providerName === "JUGUETES ELY");
    const led = FIRST_PUBLISH_AUTHORITY.find((e) => e.providerName === "LEDMOMENTS");
    expect(ely).toBeDefined();
    expect(led).toBeDefined();
    expect(ely!.providerId).not.toBe(led!.providerId);

    const eligible = FIRST_PUBLISH_AUTHORITY.filter((e) => e.decision === "ELIGIBLE");
    const ineligible = FIRST_PUBLISH_AUTHORITY.filter((e) => e.decision === "INELIGIBLE");
    expect(eligible).toHaveLength(7);
    expect(ineligible).toHaveLength(1);
    expect(FIRST_PUBLISH_AUTHORITY).toHaveLength(8);
  });

  it("authority_header_records_its_derivation", () => {
    // §2.3: la procedencia del seed tiene que estar escrita en el propio módulo.
    const src = read(AUTHORITY_MODULE);
    for (const marker of [
      "GATE2-SEED-PRECHECK",
      "2026-08-17",
      "KNOWN_PUBLICATION_TOTAL = 2044",
      "KNOWN_REMOTE_PUBLICATION_TOTAL = 2043",
      "KNOWN_PUBLICATION_WITHOUT_REMOTE_ID_TOTAL = 1",
      "KNOWN_NULL_REMOTE_PROVIDER = TOYS PALACE",
      "FIRST_GLOBAL_REMOTE_ID_MEASUREMENT = true",
    ]) {
      expect(src, `falta el marcador: ${marker}`).toContain(marker);
    }
  });

  describe("guard_decision_ignores_stock_source", () => {
    let spy: FetchSpyHandle;

    beforeEach(() => {
      spy = installWooFetchSpy();
    });
    afterEach(() => {
      spy.restore();
    });

    it("la autoridad no conoce el eje stockSource (estructural)", () => {
      // El CÓDIGO del módulo de autoridad no menciona stockSource: el eje no puede influir
      // porque no llega. (Los comentarios sí lo mencionan, justamente para documentar la
      // ortogonalidad, así que se comparan sólo las líneas ejecutables.)
      const code = read(AUTHORITY_MODULE)
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .split("\n")
        .filter((l) => !l.trim().startsWith("//"))
        .join("\n");
      expect(code).not.toMatch(/\bstockSource\b/);
      // El guard del gateway tampoco lo pasa.
      const gateway = read("lib/integrations/woocommerce/publication-service.ts");
      const guardBlock = gateway.slice(
        gateway.indexOf("GUARDARRAÍL DE PRIMERA PUBLICACIÓN"),
        gateway.indexOf("const pricing = resolvePricing("),
      );
      expect(guardBlock).not.toMatch(/\bstockSource\b/);
      // La firma toma (providerId, storeId, lookup) — tres parámetros, ninguno del producto.
      expect(canFirstPublish.length).toBe(2); // el 3º tiene default ⇒ no cuenta en .length
    });

    for (const stockSource of ["SUPPLIER", "OWN", "HYBRID"] as const) {
      it(`par E1 + stockSource=${stockSource} → ALLOW`, async () => {
        loadFakeDb(
          fakePrisma,
          buildPublishFixture({ providerId: PROVIDER_IMPOTEKNO, stockSource }),
        );
        const result = await publishProductToWoo(
          fakePrisma,
          new WooCommerceClient(STORE_URL, "k", "s"),
          STORE_ID,
          CATALOG_PRODUCT_ID,
          [],
        );
        expect(result.success).toBe(true);
        expect(result.code).toBeUndefined();
        expect(spy.count("POST")).toBe(1);
      });

      it(`par E2 + stockSource=${stockSource} → DENY`, async () => {
        loadFakeDb(
          fakePrisma,
          buildPublishFixture({ providerId: PROVIDER_DT, stockSource }),
        );
        const result = await publishProductToWoo(
          fakePrisma,
          new WooCommerceClient(STORE_URL, "k", "s"),
          STORE_ID,
          CATALOG_PRODUCT_ID,
          [],
        );
        expect(result.success).toBe(false);
        expect(result.code).toBe("FIRST_PUBLISH_NOT_ELIGIBLE");
        expect(spy.count()).toBe(0);
      });
    }

    it("la decisión es idéntica para los tres valores de stockSource", () => {
      const forEligible = (["SUPPLIER", "OWN", "HYBRID"] as const).map(() =>
        canFirstPublish(PROVIDER_IMPOTEKNO, STORE_ID),
      );
      const forIneligible = (["SUPPLIER", "OWN", "HYBRID"] as const).map(() =>
        canFirstPublish(PROVIDER_DT, STORE_ID),
      );
      expect(new Set(forEligible.map((v) => v.decision)).size).toBe(1);
      expect(forEligible[0].decision).toBe("ALLOW");
      expect(new Set(forIneligible.map((v) => v.decision)).size).toBe(1);
      expect(forIneligible[0].decision).toBe("DENY");
      expect(forIneligible[0].reason).toBe("EXPLICIT");
    });
  });
});
