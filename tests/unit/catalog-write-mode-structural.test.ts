// 2G-R7.2 §10 — estructural del enforcement PRICE_ONLY en upsertCatalogProducts (CI-safe: lee
// un archivo tracked). Verifica que el path PRICE_ONLY es angoszo, retorna antes del path FULL,
// y no toca lifecycle/publications/Woo; y que D no se toca.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const src = readFileSync(resolve(process.cwd(), "lib/catalog/upsert-catalog-products.ts"), "utf8");
const idx = (s: string) => src.indexOf(s);

describe("2G-R7.2 · PRICE_ONLY enforcement (estructural)", () => {
  it("upsert resuelve catalogWriteMode con el resolver genérico (no if provider.name)", () => {
    expect(src).toMatch(/resolveCatalogWriteMode\(/);
    expect(src).not.toMatch(/provider\.name\s*===\s*["']Different Touch["']/);
    expect(src).not.toMatch(/if\s*\(\s*canary/i);
  });

  it("el branch PRICE_ONLY RETORNA antes de la ENTRADA del path FULL (skippea toda su ejecución)", () => {
    const branch = idx('if (catalogWriteMode === "PRICE_ONLY")');
    const fullEntry = idx("const WHOLESALE_TOLERANCE"); // primer statement del path FULL
    expect(branch).toBeGreaterThan(-1);
    expect(fullEntry).toBeGreaterThan(branch);
    // early return dentro del branch, ANTES de la entrada FULL → salta el main loop, removal,
    // markPublicationsDrift, handleReappeared (que llama a publish/pauseProductInWoo), etc.
    const ret = src.indexOf("return;", branch);
    expect(ret).toBeGreaterThan(branch);
    expect(ret).toBeLessThan(fullEntry);
    // los CALLSITES de lifecycle/Woo/removal del path FULL están DESPUÉS de la entrada FULL
    for (const call of ["notIn: seenSkus", "markPublicationsDrift(", "pauseProductInWoo("]) {
      const at = idx(call);
      expect(at).toBeGreaterThan(fullEntry);
    }
  });

  it("el update PRICE_ONLY escribe SÓLO wholesalePrice + lastSeenAt + latestExtractedProductId", () => {
    const branch = idx('if (catalogWriteMode === "PRICE_ONLY")');
    const end = idx("const WHOLESALE_TOLERANCE");
    const block = src.slice(branch, end);
    // la data del update dentro del branch no debe mencionar campos comerciales/lifecycle
    for (const forbidden of ["supplierName", "supplierDescription", "supplierCategory", "supplierStatus", "internalStatus", "pausedBySystem", "stock:", "imageUrl", "productUrl:"]) {
      expect(block.includes(forbidden)).toBe(false);
    }
    expect(block).toMatch(/wholesalePrice:/);
    expect(block).toMatch(/lastSeenAt/);
    expect(block).toMatch(/latestExtractedProductId/);
  });

  it("R7.2-R1 · PREVALIDACIÓN dos fases: existencia SET-BASED + resolvePriceOnlyBatch ANTES del loop de update", () => {
    const branch = idx('if (catalogWriteMode === "PRICE_ONLY")');
    const end = idx("const WHOLESALE_TOLERANCE");
    const block = src.slice(branch, end);
    // existencia set-based (findMany ... sku: { in: ... }), NO findUnique por producto (sin N+1)
    expect(block).toMatch(/findMany\(/);
    expect(block).toMatch(/sku:\s*\{\s*in:/);
    expect(block).not.toMatch(/findUnique\(/);
    // PHASE 1 (resolvePriceOnlyBatch) ocurre ANTES de PHASE 2 (catalogProduct.update)
    const batchIdx = block.indexOf("resolvePriceOnlyBatch(");
    const updateIdx = block.indexOf("catalogProduct.update(");
    expect(batchIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(batchIdx);
  });

  it("D (pre-write-price-guard) no se importa ni se modifica desde upsert (D corre en el worker)", () => {
    expect(src).not.toMatch(/pre-write-price-guard/);
  });
});
