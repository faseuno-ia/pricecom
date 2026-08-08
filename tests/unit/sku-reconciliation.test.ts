// 2G-R8-Q2.1-A · §3 fixtures R1-R17 del clasificador puro de reconciliación SKU.
// Sin red, sin DB. Cubre las 4 clases, todas las razones (incl. EVIDENCE_CONFLICT) y las
// invariantes estructurales (NO_ABSENCE_FROM_FAILURE, NO_VARIANT_ABSENCE_WITHOUT_COMPLETE_SET,
// ABSENCE_REQUIRES_TWO_CONSISTENT_SITEMAP_WITNESSES).
import { describe, it, expect } from "vitest";
import {
  reconcileSkus,
  isPersistablePrice,
  fichaSkuIdentitySetComplete,
  type ReconcileInput,
  type ReconcileCatalogRow,
  type FichaOutcomeInfo,
  type ObservedVariant,
  type SkuResult,
  type SkuClassification,
} from "@/lib/catalog/sku-reconciliation";

const FA = "x.com/productos/a";
const FB = "x.com/productos/b";

function run(
  row: ReconcileCatalogRow,
  opts: {
    start?: string[]; end?: string[]; startOk?: boolean; endOk?: boolean;
    outcomes?: Record<string, FichaOutcomeInfo>;
    observed?: Record<string, ObservedVariant[]>;
    ambiguous?: string[];
  } = {},
): SkuResult {
  const input: ReconcileInput = {
    catalogRows: [row],
    sitemapStart: new Set(opts.start ?? []),
    sitemapEnd: new Set(opts.end ?? []),
    sitemapStartOk: opts.startOk ?? true,
    sitemapEndOk: opts.endOk ?? true,
    fichaOutcomes: new Map(Object.entries(opts.outcomes ?? {})),
    observedVariants: new Map(Object.entries(opts.observed ?? {})),
    ambiguousMappingSkus: new Set(opts.ambiguous ?? []),
  };
  return reconcileSkus(input).results[0];
}

describe("isPersistablePrice (§D / R13)", () => {
  it("sólo número finito > 0", () => {
    expect(isPersistablePrice(100)).toBe(true);
    expect(isPersistablePrice(0)).toBe(false);
    expect(isPersistablePrice(-5)).toBe(false);
    expect(isPersistablePrice(null)).toBe(false);
    expect(isPersistablePrice(NaN)).toBe(false);
    expect(isPersistablePrice(Infinity)).toBe(false);
  });
});

describe("§3 fixtures R1-R17", () => {
  it("R1) VERIFIED_OK + complete + SKU con precio → PRESENT_WITH_PRICE", () => {
    const r = run({ sku: "S1", fichaCanonicalUrl: FA, wholesalePrice: 100 }, {
      start: [FA], end: [FA], outcomes: { [FA]: { outcome: "VERIFIED_OK", variantSetComplete: true } },
      observed: { [FA]: [{ sku: "S1", priceNumber: 100 }] },
    });
    expect(r.classification).toBe("SKU_VERIFIED_PRESENT_WITH_PRICE");
    expect(r.evidenceLevel).toBe("DIRECT_CAPTURE");
  });

  it("R2) VERIFIED_OK + complete + SKU sin precio → PRESENT_WITHOUT_PRICE", () => {
    const r = run({ sku: "S1", fichaCanonicalUrl: FA, wholesalePrice: null }, {
      start: [FA], end: [FA], outcomes: { [FA]: { outcome: "VERIFIED_OK", variantSetComplete: true } },
      observed: { [FA]: [{ sku: "S1", priceNumber: null }] },
    });
    expect(r.classification).toBe("SKU_PRESENT_WITHOUT_PRICE");
  });

  it("R3) ficha ausente START y END (ambos OK) → VERIFIED_ABSENT", () => {
    const r = run({ sku: "S1", fichaCanonicalUrl: FA, wholesalePrice: 100 }, { start: [], end: [] });
    expect(r.classification).toBe("SKU_VERIFIED_ABSENT");
    expect(r.reason).toBe("ABSENT_IN_BOTH_SITEMAPS");
    expect(r.evidenceLevel).toBe("SITEMAP_TWO_WITNESS");
  });

  it("R4) VERIFIED_OK + complete + identity complete + SKU histórico no aparece → VERIFIED_ABSENT (A4)", () => {
    const r = run({ sku: "S1", fichaCanonicalUrl: FA, wholesalePrice: 100 }, {
      start: [FA], end: [FA], outcomes: { [FA]: { outcome: "VERIFIED_OK", variantSetComplete: true, skuIdentitySetComplete: true } },
      observed: { [FA]: [{ sku: "OTRO", priceNumber: 100 }] },
    });
    expect(r.classification).toBe("SKU_VERIFIED_ABSENT");
    expect(r.reason).toBe("VARIANT_NOT_IN_COMPLETE_SET");
  });

  it("R5) RATE_LIMITED → UNVERIFIED (jamás ABSENT)", () => {
    const r = run({ sku: "S1", fichaCanonicalUrl: FA, wholesalePrice: 100 }, {
      start: [FA], end: [FA], outcomes: { [FA]: { outcome: "RATE_LIMITED", variantSetComplete: "unknown" } },
    });
    expect(r.classification).toBe("SKU_UNVERIFIED");
    expect(r.reason).toBe("RATE_LIMITED");
  });

  it("R6) READ_FAILED → UNVERIFIED", () => {
    const r = run({ sku: "S1", fichaCanonicalUrl: FA, wholesalePrice: 100 }, {
      start: [FA], end: [FA], outcomes: { [FA]: { outcome: "READ_FAILED", variantSetComplete: "unknown" } },
    });
    expect(r.classification).toBe("SKU_UNVERIFIED");
    expect(r.reason).toBe("READ_FAILED");
  });

  it("R7) DATA_INCOMPLETE → UNVERIFIED", () => {
    const r = run({ sku: "S1", fichaCanonicalUrl: FA, wholesalePrice: 100 }, {
      start: [FA], end: [FA], outcomes: { [FA]: { outcome: "DATA_INCOMPLETE", variantSetComplete: "unknown" } },
    });
    expect(r.classification).toBe("SKU_UNVERIFIED");
    expect(r.reason).toBe("DATA_INCOMPLETE");
  });

  it("R8) mapping ambiguo → UNVERIFIED", () => {
    const r = run({ sku: "S1", fichaCanonicalUrl: FA, wholesalePrice: 100 }, { start: [FA], end: [FA], ambiguous: ["S1"] });
    expect(r.classification).toBe("SKU_UNVERIFIED");
    expect(r.reason).toBe("AMBIGUOUS_MAPPING");
  });

  it("R9) VERIFIED_OK + variantSetComplete=unknown + SKU no aparece → UNVERIFIED (NO ABSENT)", () => {
    const r = run({ sku: "S1", fichaCanonicalUrl: FA, wholesalePrice: 100 }, {
      start: [FA], end: [FA], outcomes: { [FA]: { outcome: "VERIFIED_OK", variantSetComplete: "unknown" } },
      observed: { [FA]: [{ sku: "OTRO", priceNumber: 100 }] },
    });
    expect(r.classification).toBe("SKU_UNVERIFIED");
    expect(r.reason).toBe("VARIANT_SET_INCOMPLETE");
    expect(r.classification).not.toBe("SKU_VERIFIED_ABSENT");
  });

  it("R10) presente START / ausente END → UNVERIFIED (drift)", () => {
    const r = run({ sku: "S1", fichaCanonicalUrl: FA, wholesalePrice: 100 }, { start: [FA], end: [] });
    expect(r.classification).toBe("SKU_UNVERIFIED");
    expect(r.reason).toBe("SITEMAP_DRIFT");
  });

  it("R11) ausente START / presente END → UNVERIFIED (drift)", () => {
    const r = run({ sku: "S1", fichaCanonicalUrl: FA, wholesalePrice: 100 }, { start: [], end: [FA] });
    expect(r.classification).toBe("SKU_UNVERIFIED");
    expect(r.reason).toBe("SITEMAP_DRIFT");
  });

  it("R12) sitemapEndOk=false → ninguna ausencia por sitemap", () => {
    const r = run({ sku: "S1", fichaCanonicalUrl: FA, wholesalePrice: 100 }, { start: [], end: [], endOk: false });
    expect(r.classification).toBe("SKU_UNVERIFIED");
    expect(r.reason).toBe("SITEMAP_UNAVAILABLE");
    expect(r.classification).not.toBe("SKU_VERIFIED_ABSENT");
  });

  it("R13) precio 0/neg/NaN/Infinity → PRESENT_WITHOUT_PRICE (no WITH_PRICE)", () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      const r = run({ sku: "S1", fichaCanonicalUrl: FA, wholesalePrice: 100 }, {
        start: [FA], end: [FA], outcomes: { [FA]: { outcome: "VERIFIED_OK", variantSetComplete: true } },
        observed: { [FA]: [{ sku: "S1", priceNumber: bad }] },
      });
      expect(r.classification).toBe("SKU_PRESENT_WITHOUT_PRICE");
    }
  });

  it("R14) 1121 SKUs sintéticos → todos clasificados, ninguno sin categoría", () => {
    const rows: ReconcileCatalogRow[] = [];
    const outcomes: Record<string, FichaOutcomeInfo> = {};
    const observed: Record<string, ObservedVariant[]> = {};
    const start: string[] = [], end: string[] = [];
    for (let i = 0; i < 1121; i++) {
      const f = `x.com/productos/p${i}`;
      const sku = `SKU${i}`;
      rows.push({ sku, fichaCanonicalUrl: f, wholesalePrice: i % 2 ? 100 : null });
      const kind = i % 5;
      if (kind === 0) { outcomes[f] = { outcome: "VERIFIED_OK", variantSetComplete: true }; observed[f] = [{ sku, priceNumber: 100 }]; start.push(f); end.push(f); }
      else if (kind === 1) { outcomes[f] = { outcome: "RATE_LIMITED", variantSetComplete: "unknown" }; start.push(f); end.push(f); }
      else if (kind === 2) { /* absent both → ABSENT */ }
      else if (kind === 3) { start.push(f); /* drift */ }
      else { outcomes[f] = { outcome: "VERIFIED_OK", variantSetComplete: "unknown" }; observed[f] = [{ sku: "x", priceNumber: 100 }]; start.push(f); end.push(f); }
    }
    const res = reconcileSkus({
      catalogRows: rows, sitemapStart: new Set(start), sitemapEnd: new Set(end),
      sitemapStartOk: true, sitemapEndOk: true,
      fichaOutcomes: new Map(Object.entries(outcomes)), observedVariants: new Map(Object.entries(observed)),
    });
    expect(res.results.length).toBe(1121);
    expect(res.summary.total).toBe(1121);
    const sum = res.summary.verifiedPresentWithPrice + res.summary.presentWithoutPrice + res.summary.verifiedAbsent + res.summary.unverified;
    expect(sum).toBe(1121); // ninguna fila sin categoría
    const VALID = ["SKU_VERIFIED_PRESENT_WITH_PRICE", "SKU_PRESENT_WITHOUT_PRICE", "SKU_VERIFIED_ABSENT", "SKU_UNVERIFIED"];
    expect(res.results.every((r) => VALID.includes(r.classification))).toBe(true);
  });

  it("R15) sitemap ausente START+END + VERIFIED_OK → EVIDENCE_CONFLICT (nunca ABSENT/PRESENT)", () => {
    const r = run({ sku: "S1", fichaCanonicalUrl: FA, wholesalePrice: 100 }, {
      start: [], end: [], outcomes: { [FA]: { outcome: "VERIFIED_OK", variantSetComplete: true } },
      observed: { [FA]: [{ sku: "S1", priceNumber: 100 }] },
    });
    expect(r.classification).toBe("SKU_UNVERIFIED");
    expect(r.reason).toBe("EVIDENCE_CONFLICT");
    expect(r.conflictSources).toEqual(["SITEMAP_ABSENT_BOTH", "FICHA_OUTCOME_VERIFIED_OK"]);
  });

  it("R16) READ_FAILED + observedVariants contiene el SKU → UNVERIFIED (la evidencia fallida tiene precedencia)", () => {
    const r = run({ sku: "S1", fichaCanonicalUrl: FA, wholesalePrice: 100 }, {
      start: [FA], end: [FA], outcomes: { [FA]: { outcome: "READ_FAILED", variantSetComplete: "unknown" } },
      observed: { [FA]: [{ sku: "S1", priceNumber: 100 }] },
    });
    expect(r.classification).toBe("SKU_UNVERIFIED");
    expect(r.reason).toBe("READ_FAILED"); // precedencia de falla, NO PRESENT
    expect(r.classification).not.toBe("SKU_VERIFIED_PRESENT_WITH_PRICE");
  });

  it("R17) catalog mapea ficha A pero observado inequívocamente en ficha B → EVIDENCE_CONFLICT", () => {
    const r = run({ sku: "S1", fichaCanonicalUrl: FA, wholesalePrice: 100 }, {
      start: [FA, FB], end: [FA, FB],
      outcomes: { [FA]: { outcome: "VERIFIED_OK", variantSetComplete: true } },
      observed: { [FB]: [{ sku: "S1", priceNumber: 100 }] },
    });
    expect(r.classification).toBe("SKU_UNVERIFIED");
    expect(r.reason).toBe("EVIDENCE_CONFLICT");
    expect(r.conflictSources).toEqual(["CATALOG_MAPPING", "OBSERVED_MAPPING"]);
  });
});

describe("§4 fixtures R18-R23 (identidad SKU + descubrimiento del proveedor)", () => {
  it("fichaSkuIdentitySetComplete: count>0 → false, count=0/null → true", () => {
    expect(fichaSkuIdentitySetComplete(1)).toBe(false);
    expect(fichaSkuIdentitySetComplete(3)).toBe(false);
    expect(fichaSkuIdentitySetComplete(0)).toBe(true);
    expect(fichaSkuIdentitySetComplete(null)).toBe(true);
    expect(fichaSkuIdentitySetComplete(undefined)).toBe(true);
  });

  it("R18) quarantineCount>0 (MISSING_SKU) + variantSetComplete=true + SKU no observado → UNVERIFIED (NO ABSENT)", () => {
    const idComplete = fichaSkuIdentitySetComplete(1); // 1 variante retirada por cuarentena
    const r = run({ sku: "S1", fichaCanonicalUrl: FA, wholesalePrice: 100 }, {
      start: [FA], end: [FA],
      outcomes: { [FA]: { outcome: "VERIFIED_OK", variantSetComplete: true, skuIdentitySetComplete: idComplete } },
      observed: { [FA]: [{ sku: "OTRO", priceNumber: 100 }] },
    });
    expect(r.classification).toBe("SKU_UNVERIFIED");
    expect(r.reason).toBe("SKU_IDENTITY_SET_INCOMPLETE");
    expect(r.classification).not.toBe("SKU_VERIFIED_ABSENT");
  });

  it("R19) ídem con NO_USABLE_NAME (mismo mecanismo: identidad incompleta) → UNVERIFIED (NO ABSENT)", () => {
    // NO_USABLE_NAME también retira una variante del set reconciliable → skuIdentitySetComplete=false.
    const r = run({ sku: "S1", fichaCanonicalUrl: FA, wholesalePrice: 100 }, {
      start: [FA], end: [FA],
      outcomes: { [FA]: { outcome: "VERIFIED_OK", variantSetComplete: true, skuIdentitySetComplete: false } },
      observed: { [FA]: [{ sku: "OTRO", priceNumber: 100 }] },
    });
    expect(r.classification).toBe("SKU_UNVERIFIED");
    expect(r.reason).toBe("SKU_IDENTITY_SET_INCOMPLETE");
  });

  it("R20) quarantineCount=0 + variantSetComplete=true + identityComplete + SKU no observado → VERIFIED_ABSENT (única vía)", () => {
    const idComplete = fichaSkuIdentitySetComplete(0);
    expect(idComplete).toBe(true);
    const r = run({ sku: "S1", fichaCanonicalUrl: FA, wholesalePrice: 100 }, {
      start: [FA], end: [FA],
      outcomes: { [FA]: { outcome: "VERIFIED_OK", variantSetComplete: true, skuIdentitySetComplete: idComplete } },
      observed: { [FA]: [{ sku: "OTRO", priceNumber: 100 }] },
    });
    expect(r.classification).toBe("SKU_VERIFIED_ABSENT");
    expect(r.reason).toBe("VARIANT_NOT_IN_COMPLETE_SET");
  });

  it("R21) SKU observado sin fila de catálogo → NO aparece en catalogRowClassification, sí en NEW_PROVIDER_SKUS", () => {
    const res = reconcileSkus({
      catalogRows: [{ sku: "EXIST", fichaCanonicalUrl: FA, wholesalePrice: 100 }],
      sitemapStart: new Set([FA]), sitemapEnd: new Set([FA]), sitemapStartOk: true, sitemapEndOk: true,
      fichaOutcomes: new Map([[FA, { outcome: "VERIFIED_OK", variantSetComplete: true, skuIdentitySetComplete: true }]]),
      observedVariants: new Map([[FA, [{ sku: "EXIST", priceNumber: 100 }, { sku: "NUEVO", priceNumber: 200 }]]]),
    });
    expect(res.results.map((r) => r.sku)).toEqual(["EXIST"]); // NUEVO NO se clasifica como fila de catálogo
    expect(res.providerDiscovery.newProviderSkus).toEqual(["NUEVO"]);
    expect(res.providerDiscovery.providerNewSkuCount).toBe(1);
    expect(res.providerDiscovery.providerNewFichaCount).toBe(1);
  });

  it("R22) batch con SKUs existentes válidos + nuevos → existentes siguen candidatos; nuevos NO abortan", () => {
    const res = reconcileSkus({
      catalogRows: [{ sku: "EXIST", fichaCanonicalUrl: FA, wholesalePrice: 100 }],
      sitemapStart: new Set([FA]), sitemapEnd: new Set([FA]), sitemapStartOk: true, sitemapEndOk: true,
      fichaOutcomes: new Map([[FA, { outcome: "VERIFIED_OK", variantSetComplete: true, skuIdentitySetComplete: true }]]),
      observedVariants: new Map([[FA, [{ sku: "EXIST", priceNumber: 100 }, { sku: "NUEVO", priceNumber: 200 }]]]),
    });
    // el existente clasifica normalmente (candidato a price write); el nuevo no lo invalida ni aborta.
    expect(res.results.find((r) => r.sku === "EXIST")?.classification).toBe("SKU_VERIFIED_PRESENT_WITH_PRICE");
    expect(res.providerDiscovery.providerNewSkuCount).toBe(1);
    // NEW_PROVIDER_SKUS_CAN_ABORT_EXISTING_PRICE_BATCH = false (la función no lanza ni descarta el existente)
  });

  it("R23) el enum SkuClassification NO contiene NEW_PROVIDER_SKU (type-level)", () => {
    // @ts-expect-error NEW_PROVIDER_SKU no es un SkuClassification válido (si alguien lo agrega, este error desaparece y CI falla)
    const bad: SkuClassification = "NEW_PROVIDER_SKU";
    expect(bad).toBe("NEW_PROVIDER_SKU"); // runtime trivial; el guard real es el @ts-expect-error
  });
});

describe("invariantes estructurales", () => {
  it("NO_ABSENCE_FROM_FAILURE: ningún outcome de falla produce ABSENT (aunque el sitemap lo permitiría)", () => {
    for (const outcome of ["RATE_LIMITED", "READ_FAILED", "DATA_INCOMPLETE"] as const) {
      // ficha ausente en ambos sitemaps (permitiría A3) PERO con outcome de falla.
      const r = run({ sku: "S1", fichaCanonicalUrl: FA, wholesalePrice: 100 }, {
        start: [], end: [], outcomes: { [FA]: { outcome, variantSetComplete: "unknown" } },
      });
      expect(r.classification).not.toBe("SKU_VERIFIED_ABSENT");
      expect(r.classification).toBe("SKU_UNVERIFIED");
    }
  });

  it("EVIDENCE_CONFLICT nunca produce ABSENT ni PRESENT", () => {
    const conflict = run({ sku: "S1", fichaCanonicalUrl: FA, wholesalePrice: 100 }, {
      start: [], end: [], outcomes: { [FA]: { outcome: "VERIFIED_OK", variantSetComplete: true } },
    });
    expect(conflict.reason).toBe("EVIDENCE_CONFLICT");
    expect(["SKU_VERIFIED_ABSENT", "SKU_VERIFIED_PRESENT_WITH_PRICE", "SKU_PRESENT_WITHOUT_PRICE"]).not.toContain(conflict.classification);
  });

  it("summary.byReason y evidenceConflictCount agregan correctamente", () => {
    const res = reconcileSkus({
      catalogRows: [
        { sku: "A", fichaCanonicalUrl: FA, wholesalePrice: 100 },
        { sku: "B", fichaCanonicalUrl: FB, wholesalePrice: 100 },
      ],
      sitemapStart: new Set(), sitemapEnd: new Set(), sitemapStartOk: true, sitemapEndOk: true,
      fichaOutcomes: new Map([
        [FA, { outcome: "VERIFIED_OK", variantSetComplete: true }],
        [FB, { outcome: "VERIFIED_OK", variantSetComplete: true }],
      ]),
      observedVariants: new Map(),
    });
    // ambas fichas ausentes en ambos + VERIFIED_OK → 2 EVIDENCE_CONFLICT
    expect(res.evidenceConflictCount).toBe(2);
    expect(res.summary.byReason["EVIDENCE_CONFLICT"]).toBe(2);
    expect(res.evidenceConflictSample.length).toBe(2);
  });
});
