// 2G-R8-Q2.1-B · §3 — ensamblado puro de los inputs del clasificador desde la data cruda del walk.
import { describe, it, expect } from "vitest";
import { assembleReconcileInput, type AssemblyPartial, type AssemblyCatalogRow } from "@/lib/catalog/reconciliation-assembly";
import { reconcileSkus } from "@/lib/catalog/sku-reconciliation";

const FA = "https://differenttouch.com.ar/productos/a";
const FB = "https://differenttouch.com.ar/productos/b";
const canon = "differenttouch.com.ar/productos/a";

describe("assembleReconcileInput", () => {
  const catalog: AssemblyCatalogRow[] = [
    { sku: "A1", productUrl: FA, wholesalePrice: 100 },
    { sku: "A2", productUrl: FA, wholesalePrice: null },
    { sku: "B1", productUrl: FB, wholesalePrice: 50 },
  ];

  it("indexa todo por ficha canónica y computa outcomes/observed correctamente", () => {
    const partial: AssemblyPartial = {
      products: [
        { sku: "A1", productUrl: FA, wholesalePrice: 110 },
        { sku: "A2", productUrl: FA, wholesalePrice: null }, // presente sin precio
      ],
      fichaObservations: [
        { url: FA, outcome: "VERIFIED_OK", variantSetComplete: true },
        { url: FB, outcome: "RATE_LIMITED", variantSetComplete: "unknown" },
      ],
      fichaQuarantine: {},
      sitemapStartUrls: [canon, "differenttouch.com.ar/productos/b"],
      sitemapEndUrls: [canon, "differenttouch.com.ar/productos/b"],
      sitemapStartOk: true,
      sitemapEndOk: true,
    };
    const { input, fichaOutcomeCounts, eligibleMappedCatalogSkuCount } = assembleReconcileInput(partial, catalog);
    expect(input.fichaOutcomes.get(canon)?.outcome).toBe("VERIFIED_OK");
    expect(input.fichaOutcomes.get(canon)?.skuIdentitySetComplete).toBe(true); // sin cuarentena
    expect(input.observedVariants.get(canon)?.map((v) => v.sku).sort()).toEqual(["A1", "A2"]);
    expect(fichaOutcomeCounts).toEqual({ verifiedOk: 1, dataIncomplete: 0, readFailed: 0, rateLimited: 1 });
    expect(eligibleMappedCatalogSkuCount).toBe(3);

    // pipeline completo: clasifica sin sorpresas.
    const rec = reconcileSkus(input);
    const byId = Object.fromEntries(rec.results.map((r) => [r.sku, r]));
    expect(byId["A1"].classification).toBe("SKU_VERIFIED_PRESENT_WITH_PRICE");
    expect(byId["A2"].classification).toBe("SKU_PRESENT_WITHOUT_PRICE");
    expect(byId["B1"].classification).toBe("SKU_UNVERIFIED"); // ficha RATE_LIMITED
    expect(byId["B1"].reason).toBe("RATE_LIMITED");
  });

  it("una ficha con cuarentena → skuIdentitySetComplete=false (canónico) → cierra falso ABSENT", () => {
    const partial: AssemblyPartial = {
      products: [{ sku: "A1", productUrl: FA, wholesalePrice: 110 }], // A2 no observado
      fichaObservations: [{ url: FA, outcome: "VERIFIED_OK", variantSetComplete: true }],
      fichaQuarantine: { [FA]: { count: 1 } }, // clave cruda → se canonicaliza
      sitemapStartUrls: [canon], sitemapEndUrls: [canon], sitemapStartOk: true, sitemapEndOk: true,
    };
    const { input } = assembleReconcileInput(partial, catalog);
    expect(input.fichaOutcomes.get(canon)?.skuIdentitySetComplete).toBe(false);
    const rec = reconcileSkus(input);
    const a2 = rec.results.find((r) => r.sku === "A2");
    expect(a2?.classification).toBe("SKU_UNVERIFIED"); // NO falso ABSENT
    expect(a2?.reason).toBe("SKU_IDENTITY_SET_INCOMPLETE");
  });
});
