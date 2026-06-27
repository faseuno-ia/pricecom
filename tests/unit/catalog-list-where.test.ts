// TDD — el buscador del catálogo debe matchear por SKU comercial canónico
// (ProductPublication.sku) y por el SKU externo de Woo (ProductPublication.externalSku),
// además del SKU proveedor (CatalogProduct.sku) y el legacy (CatalogProduct.publicationSku).
//
// Tests de SHAPE: buildCatalogListWhere es pura (devuelve Prisma.WhereInput). Cada
// assert verifica la PRESENCIA de una rama en where.OR, no qué fila devuelve. Sin DB.

import { describe, it, expect } from "vitest";
import { buildCatalogListWhere } from "@/lib/catalog/list-filters";
import type { Prisma } from "@prisma/client";

const USER = "user-1";

function whereFor(params: Record<string, string>): Prisma.CatalogProductWhereInput {
  return buildCatalogListWhere(USER, new URLSearchParams(params));
}
const orOf = (w: Prisma.CatalogProductWhereInput) =>
  (w.OR ?? []) as Prisma.CatalogProductWhereInput[];

describe("buildCatalogListWhere — búsqueda por SKUs", () => {
  it("1. busca por CatalogProduct.sku (SKU proveedor)", () => {
    const or = orOf(whereFor({ search: "12345" }));
    expect(or).toContainEqual({ sku: { contains: "12345", mode: "insensitive" } });
  });

  it("2. busca por CatalogProduct.publicationSku (legacy, presente)", () => {
    const or = orOf(whereFor({ search: "ELY-12345" }));
    expect(or).toContainEqual({
      publicationSku: { contains: "ELY-12345", mode: "insensitive" },
    });
  });

  it("3. busca por ProductPublication.sku (comercial canónico)", () => {
    const or = orOf(whereFor({ search: "ELY-12345" }));
    expect(or).toContainEqual({
      publications: { some: { sku: { contains: "ELY-12345", mode: "insensitive" } } },
    });
  });

  it("4. busca por ProductPublication.externalSku (SKU observado en Woo)", () => {
    const or = orOf(whereFor({ search: "ELY-ALT-12345" }));
    expect(or).toContainEqual({
      publications: {
        some: { externalSku: { contains: "ELY-ALT-12345", mode: "insensitive" } },
      },
    });
  });

  it("5. conserva las 5 ramas escalares previas", () => {
    const or = orOf(whereFor({ search: "x" }));
    expect(or).toContainEqual({ supplierName: { contains: "x", mode: "insensitive" } });
    expect(or).toContainEqual({ commercialTitle: { contains: "x", mode: "insensitive" } });
    expect(or).toContainEqual({ commercialName: { contains: "x", mode: "insensitive" } });
    expect(or).toContainEqual({ sku: { contains: "x", mode: "insensitive" } });
    expect(or).toContainEqual({ publicationSku: { contains: "x", mode: "insensitive" } });
  });

  it("6. son DOS ramas publications SEPARADAS (no un solo some con OR interno)", () => {
    const or = orOf(whereFor({ search: "x" }));
    const pubBranches = or.filter((b) => "publications" in b);
    expect(pubBranches).toHaveLength(2);
    // Cada rama tiene un `some` con UNA sola key (sku o externalSku), nunca un OR interno.
    for (const b of pubBranches) {
      const some = (b.publications as { some: Record<string, unknown> }).some;
      expect(some).not.toHaveProperty("OR");
      expect(Object.keys(some)).toHaveLength(1);
    }
    // Una para sku, otra para externalSku.
    const keys = pubBranches
      .map((b) => Object.keys((b.publications as { some: object }).some)[0])
      .sort();
    expect(keys).toEqual(["externalSku", "sku"]);
  });
});

describe("buildCatalogListWhere — composición búsqueda + estado", () => {
  it("7a. search + internalStatus: coexisten (OR de búsqueda + internalStatus AND-eado)", () => {
    const w = whereFor({ search: "x", internalStatus: "PUBLISHED" });
    // La búsqueda sigue en where.OR…
    expect(orOf(w)).toContainEqual({ sku: { contains: "x", mode: "insensitive" } });
    expect(orOf(w)).toContainEqual({
      publications: { some: { sku: { contains: "x", mode: "insensitive" } } },
    });
    // …y el filtro de estado sigue como campo top-level (AND implícito), sin pisarse.
    expect(w.internalStatus).toBe("PUBLISHED");
  });

  it("7b. search + visualStatus: el OR de búsqueda y el fragmento de estado (where.AND) coexisten", () => {
    const w = whereFor({ search: "x", visualStatus: "OUTDATED" });
    // Búsqueda intacta en where.OR.
    expect(orOf(w)).toContainEqual({
      publications: { some: { externalSku: { contains: "x", mode: "insensitive" } } },
    });
    // El estado visual OUTDATED entró en where.AND (su propio publications.some), sin pisar el OR.
    const and = (w.AND ?? []) as Prisma.CatalogProductWhereInput[];
    expect(and.length).toBeGreaterThanOrEqual(1);
    expect(and.some((f) => f.internalStatus === "PUBLISHED" && "publications" in f)).toBe(true);
    // El OR de búsqueda no quedó vacío ni pisado.
    expect(orOf(w).length).toBeGreaterThanOrEqual(7);
  });
});
