// A3-P1 §14 — inventario allowlisted de la autoridad de completitud R2. Falla si aparece un
// consumidor nuevo de r2OkAllowed/walkAllowsR2Ok, o si alguno pasa a determinar COMPLETE/exit 0.
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  resolveSitemapCompletenessOutcome,
} from "@/lib/scraper/sitemap-completeness";

const root = process.cwd();

function tsFilesUnder(dir: string): string[] {
  try {
    return (readdirSync(resolve(root, dir), { recursive: true, encoding: "utf8" }) as string[])
      .filter((f) => f.endsWith(".ts"))
      .map((f) => join(dir, f).replace(/\\/g, "/"));
  } catch {
    return [];
  }
}

const ALL_TS = ["lib", "scripts", "worker", "tests"].flatMap(tsFilesUnder);

// Allowlist: def del helper + único call-site del recon + su test + este inventario (que
// menciona los identificadores como literales de string).
const ALLOWLIST = new Set([
  "lib/ops/a41-recon-core.ts",
  "scripts/_a41-recon.ts",
  "tests/unit/a41-recon.test.ts",
  "tests/unit/r2-completeness-authority-inventory.test.ts",
]);

describe("§14 — allowlist de r2OkAllowed / walkAllowsR2Ok", () => {
  it("ningún consumidor nuevo fuera de la allowlist", () => {
    const consumers = ALL_TS.filter((f) => {
      const src = readFileSync(resolve(root, f), "utf8");
      return /r2OkAllowed|walkAllowsR2Ok/.test(src);
    });
    for (const c of consumers) expect(ALLOWLIST.has(c)).toBe(true);
  });

  it("el caller final del recon usa resolveSitemapCompletenessOutcome como autoridad", () => {
    const recon = readFileSync(resolve(root, "scripts/_a41-recon.ts"), "utf8");
    expect(recon).toMatch(/resolveSitemapCompletenessOutcome\(/);
    // el exit/status sale del adaptador de la autoridad, no de r2OkAllowed
    expect(recon).toMatch(/mapSitemapOutcomeToReconResult/);
  });

  it("r2OkAllowed/walkAllowsR2Ok NO determinan COMPLETE ni exit 0 (son intermedios/reporte)", () => {
    const recon = readFileSync(resolve(root, "scripts/_a41-recon.ts"), "utf8");
    // r2OkAllowed sólo aparece como campo del diff informativo, no controlando exitCode
    expect(recon).not.toMatch(/exitCode\s*=\s*[^;]*r2OkAllowed/);
    expect(recon).not.toMatch(/r2OkAllowed[^;]*\?\s*0\s*:/);
  });
});

describe("§14 — caso conductual preservado (autoridad compartida)", () => {
  it("walk COMPLETE + reference EXPLICITLY_EMPTY → complete=false / reason EXPLICITLY_EMPTY", () => {
    const r = resolveSitemapCompletenessOutcome({
      walkStatus: "COMPLETE",
      referenceKind: "EXPLICITLY_EMPTY_REFERENCE",
      normalizedReferenceCount: 0,
      exactSetMatch: false,
    });
    expect(r.complete).toBe(false);
    expect(r.reasonCode).toBe("R2_SITEMAP_REFERENCE_EXPLICITLY_EMPTY");
  });
});
