// 2G-R8-Q2 · §9 — Mapeo FICHA↔SKU: identidad canónica (T19) + auditoría del catálogo.
import { describe, it, expect } from "vitest";
import {
  fichaIdentity,
  buildFichaToSkusMap,
  buildCatalogSkuToFichaMap,
} from "@/lib/scraper/ficha-sku-map";

describe("fichaIdentity — canonicalización (§9 / T19)", () => {
  it("T19a) trailing slash: con y sin '/' → misma identidad", () => {
    expect(fichaIdentity("https://x.com/productos/a/")).toBe("x.com/productos/a");
    expect(fichaIdentity("https://x.com/productos/a")).toBe("x.com/productos/a");
    expect(fichaIdentity("https://x.com/productos/a/")).toBe(fichaIdentity("https://x.com/productos/a"));
  });
  it("T19b) query y fragment se descartan de la identidad", () => {
    expect(fichaIdentity("https://x.com/productos/a?ref=1&x=2#seccion")).toBe("x.com/productos/a");
  });
  it("T19c) scheme y case del host no forman parte de la identidad", () => {
    expect(fichaIdentity("http://X.COM/productos/a")).toBe("x.com/productos/a");
    expect(fichaIdentity("productos") === fichaIdentity("productos")).toBe(true);
  });
  it("T19d) fichas de paths distintos → identidades DISTINTAS (no se mezclan)", () => {
    expect(fichaIdentity("https://x.com/productos/a")).not.toBe(fichaIdentity("https://x.com/productos/b"));
  });
  it("vacío/inválido → null", () => {
    expect(fichaIdentity(null)).toBeNull();
    expect(fichaIdentity("")).toBeNull();
    expect(fichaIdentity("   ")).toBeNull();
  });
});

describe("buildFichaToSkusMap — desde captura", () => {
  it("agrupa SKUs por identidad canónica; variantes con/sin slash NO se mezclan como fichas distintas", () => {
    const map = buildFichaToSkusMap([
      { fichaUrl: "https://x.com/productos/a/", navigationUrl: "https://x.com/productos/a/", skus: ["S1", "S2"] },
      { fichaUrl: "https://x.com/productos/a", navigationUrl: "https://x.com/productos/a", skus: ["S2", "S3"] }, // misma ficha
      { fichaUrl: "https://x.com/productos/b", navigationUrl: "https://x.com/productos/b", skus: ["S9", " "] },
    ]);
    expect(map["x.com/productos/a"]).toEqual(["S1", "S2", "S3"]); // dedup + orden, misma ficha
    expect(map["x.com/productos/b"]).toEqual(["S9"]); // SKU vacío descartado
    expect(Object.keys(map).sort()).toEqual(["x.com/productos/a", "x.com/productos/b"]);
  });
  it("fichaUrl null → cae al navigationUrl canónico", () => {
    const map = buildFichaToSkusMap([{ fichaUrl: null, navigationUrl: "https://x.com/productos/c/", skus: ["Z"] }]);
    expect(map["x.com/productos/c"]).toEqual(["Z"]);
  });
});

describe("buildCatalogSkuToFichaMap — auditoría §9", () => {
  it("catálogo sano → resolvable, 0 unmappable, 0 colisiones", () => {
    const r = buildCatalogSkuToFichaMap([
      { sku: "A", productUrl: "https://x.com/productos/a" },
      { sku: "B", productUrl: "https://x.com/productos/a" }, // misma ficha, distinto SKU (normal)
      { sku: "C", productUrl: "https://x.com/productos/c/" },
    ]);
    expect(r.resolvable).toBe(true);
    expect(r.unmappableCount).toBe(0);
    expect(r.collisionCount).toBe(0);
    expect(r.rowsWithoutSku).toBe(0);
    expect(r.distinctSkus).toBe(3);
    expect(r.distinctFichas).toBe(2);
    expect(r.skuToFicha["A"]).toBe("x.com/productos/a");
    expect(r.skuToFicha["C"]).toBe("x.com/productos/c");
  });
  it("SKU sin productUrl resoluble → UNMAPPABLE", () => {
    const r = buildCatalogSkuToFichaMap([
      { sku: "A", productUrl: "https://x.com/productos/a" },
      { sku: "NOPE", productUrl: null },
      { sku: "BAD", productUrl: "   " },
    ]);
    expect(r.unmappableSkus).toEqual(["BAD", "NOPE"]);
    expect(r.unmappableCount).toBe(2);
    expect(r.resolvable).toBe(false);
  });
  it("mismo SKU en 2 fichas distintas → COLLISION (y no entra a skuToFicha)", () => {
    const r = buildCatalogSkuToFichaMap([
      { sku: "DUP", productUrl: "https://x.com/productos/a" },
      { sku: "DUP", productUrl: "https://x.com/productos/b" },
    ]);
    expect(r.collisionSkus).toEqual(["DUP"]);
    expect(r.collisionCount).toBe(1);
    expect(r.skuToFicha["DUP"]).toBeUndefined();
    expect(r.resolvable).toBe(false);
  });
  it("filas sin SKU se cuentan aparte (no unmappable)", () => {
    const r = buildCatalogSkuToFichaMap([
      { sku: "", productUrl: "https://x.com/productos/a" },
      { sku: null, productUrl: "https://x.com/productos/b" },
      { sku: "OK", productUrl: "https://x.com/productos/c" },
    ]);
    expect(r.rowsWithoutSku).toBe(2);
    expect(r.unmappableCount).toBe(0);
    expect(r.distinctSkus).toBe(1);
  });
});
