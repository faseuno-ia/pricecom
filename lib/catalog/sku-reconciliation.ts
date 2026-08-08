// 2G-R8-Q2.1-A · Clasificador PURO de reconciliación SKU (Nivel 2). Implementa las reglas
// A1–A8 pre-registradas en Q2 + EVIDENCE_CONFLICT (§2.1). SIN red, SIN Prisma, SIN reloj:
// todas las entradas son explícitas. Determinístico.
//
// INVARIANTES ESTRUCTURALES (imposibles por CONSTRUCCIÓN, no por convención):
//   NO_ABSENCE_FROM_FAILURE            — un outcome RATE_LIMITED/READ_FAILED/DATA_INCOMPLETE
//     retorna UNVERIFIED en un TIER que precede a TODA derivación de ausencia.
//   NO_VARIANT_ABSENCE_WITHOUT_COMPLETE_SET — la ausencia por variante (A4) exige
//     variantSetComplete === true; cualquier otro valor cae a UNVERIFIED.
//   ABSENCE_REQUIRES_TWO_CONSISTENT_SITEMAP_WITNESSES — la ausencia por sitemap (A3) exige
//     sitemapStartOk && sitemapEndOk && ausente-en-AMBOS; drift ⇒ UNVERIFIED.
//   AMBIGUOUS/UNMAPPABLE ⇒ UNVERIFIED.
//   EVIDENCE_CONFLICT ⇒ SIEMPRE UNVERIFIED (nunca ABSENT ni PRESENT).
//
// El único código que devuelve SKU_VERIFIED_ABSENT vive en dos ramas (A4 y A3), ambas
// guardadas por las condiciones anteriores. Por eso ABSENCE_UNREACHABLE_FROM_FAILURE_BY_TYPE
// = true de forma estructural.

export type SkuClassification =
  | "SKU_VERIFIED_PRESENT_WITH_PRICE"
  | "SKU_PRESENT_WITHOUT_PRICE"
  | "SKU_VERIFIED_ABSENT"
  | "SKU_UNVERIFIED";

export type FichaOutcome = "VERIFIED_OK" | "DATA_INCOMPLETE" | "RATE_LIMITED" | "READ_FAILED";
export type VariantSetComplete = boolean | "unknown";

export type SkuReason =
  // UNVERIFIED
  | "RATE_LIMITED"
  | "READ_FAILED"
  | "DATA_INCOMPLETE"
  | "EVIDENCE_CONFLICT"
  | "AMBIGUOUS_MAPPING"
  | "UNMAPPABLE_MAPPING"
  | "VARIANT_SET_INCOMPLETE"
  | "SKU_IDENTITY_SET_INCOMPLETE"
  | "SITEMAP_DRIFT"
  | "SITEMAP_UNAVAILABLE"
  | "NOT_OBSERVED"
  // VERIFIED_ABSENT
  | "ABSENT_IN_BOTH_SITEMAPS"
  | "VARIANT_NOT_IN_COMPLETE_SET";

export type EvidenceLevel = "DIRECT_CAPTURE" | "SITEMAP_TWO_WITNESS" | "NONE";

export interface ReconcileCatalogRow {
  sku: string;
  /** Ficha canónica del SKU según el catálogo histórico (o null si no resuelve). */
  fichaCanonicalUrl: string | null;
  /** Precio de reposición histórico del catálogo (para caracterizar; el precio "actual" viene de observedVariants). */
  wholesalePrice: number | null;
}

export interface ObservedVariant {
  sku: string;
  priceNumber: number | null;
}

export interface FichaOutcomeInfo {
  outcome: FichaOutcome;
  /** Witness §3.2: vimos TODAS las variantes de la ficha. */
  variantSetComplete: VariantSetComplete;
  /**
   * 2G-R8-Q2.1-A-R1 · §3 — witness INDEPENDIENTE: pudimos reconciliar inequívocamente la
   * IDENTIDAD SKU de todas las variantes relevantes. Una ficha con CUALQUIER variante retirada
   * por cuarentena (por cualquier reason) tiene skuIdentitySetComplete=false. OPCIONAL: si falta,
   * se trata como NO-completa (fail-safe: la ausencia por variante exige === true, nunca se infiere
   * ausencia por omisión). Derivable de fichaQuarantine del walk vía fichaSkuIdentitySetComplete().
   */
  skuIdentitySetComplete?: VariantSetComplete;
}

export interface ReconcileInput {
  catalogRows: ReconcileCatalogRow[];
  /** Sets de fichas canónicas de los DOS snapshots del sitemap (§5). */
  sitemapStart: Set<string>;
  sitemapEnd: Set<string>;
  sitemapStartOk: boolean;
  sitemapEndOk: boolean;
  /** Outcome de captura por ficha canónica (vacío si no hubo walk). */
  fichaOutcomes: Map<string, FichaOutcomeInfo>;
  /** Variantes observadas por ficha canónica (vacío si no hubo walk). */
  observedVariants: Map<string, ObservedVariant[]>;
  /** SKUs con mapping ambiguo (colisión catálogo). Opcional. */
  ambiguousMappingSkus?: Set<string>;
}

export interface SkuResult {
  sku: string;
  classification: SkuClassification;
  reason: SkuReason | null;
  evidenceLevel: EvidenceLevel;
  /** Sólo presente cuando reason === EVIDENCE_CONFLICT: las DOS fuentes que se contradicen. */
  conflictSources?: [string, string];
}

export interface ReconcileSummary {
  total: number;
  verifiedPresentWithPrice: number;
  presentWithoutPrice: number;
  verifiedAbsent: number;
  unverified: number;
  byReason: Record<string, number>;
}

/**
 * 2G-R8-Q2.1-A-R1 · §2 — EJE SEPARADO (no un 5º valor del enum de fila de catálogo). SKUs
 * observados en el proveedor SIN fila de catálogo. Se detectan, particionan y reportan; NUNCA
 * se escriben (NEW_PROVIDER_SKUS_INSERTED = 0) ni pueden abortar un batch de precios existente.
 */
export interface ProviderDiscovery {
  newProviderSkus: string[];
  providerNewSkuCount: number;
  providerNewFichaCount: number;
  /** máx 20. */
  newProviderSkusSample: string[];
}

export interface ReconcileResult {
  results: SkuResult[];
  summary: ReconcileSummary;
  evidenceConflictCount: number;
  /** Máx 10; cada uno con las dos fuentes en conflicto. */
  evidenceConflictSample: Array<{ sku: string; sources: [string, string] }>;
  /** §2 · eje independiente de descubrimiento del proveedor (SKUs nuevos, no en el catálogo). */
  providerDiscovery: ProviderDiscovery;
}

/**
 * 2G-R8-Q2.1-A-R1 · §3.1 bridge — deriva el witness FICHA_SKU_IDENTITY_SET_COMPLETE desde la
 * metadata `fichaQuarantine` del walk: una ficha con CUALQUIER variante en cuarentena (count>0,
 * por cualquier reason) NO tiene identidad SKU completa. Puro.
 */
export function fichaSkuIdentitySetComplete(quarantineCount: number | undefined | null): boolean {
  return !(typeof quarantineCount === "number" && quarantineCount > 0);
}

/** Precio persistible: número finito estrictamente positivo (§ D / R13). null/NaN/Infinity/≤0 → no. */
export function isPersistablePrice(p: number | null | undefined): boolean {
  return typeof p === "number" && Number.isFinite(p) && p > 0;
}

/** Índice inverso: sku observado → set de fichas donde se observó (para detectar conflicto de mapeo). */
function buildObservedSkuToFichas(observedVariants: Map<string, ObservedVariant[]>): Map<string, Set<string>> {
  const idx = new Map<string, Set<string>>();
  for (const [ficha, variants] of observedVariants) {
    for (const v of variants) {
      const sku = (v.sku ?? "").trim();
      if (sku === "") continue;
      if (!idx.has(sku)) idx.set(sku, new Set());
      idx.get(sku)!.add(ficha);
    }
  }
  return idx;
}

const unverified = (sku: string, reason: SkuReason, conflictSources?: [string, string]): SkuResult => ({
  sku, classification: "SKU_UNVERIFIED", reason, evidenceLevel: "NONE", ...(conflictSources ? { conflictSources } : {}),
});

/**
 * Clasifica UN SKU. La PRECEDENCIA de tiers es la que hace estructurales las invariantes:
 *   TIER 0  mapping (unmappable/ambiguo)        → UNVERIFIED
 *   TIER 1  outcome de FALLA                    → UNVERIFIED (NO_ABSENCE_FROM_FAILURE)
 *   TIER 2  EVIDENCE_CONFLICT                   → UNVERIFIED (§2.1; nunca ABSENT/PRESENT)
 *   TIER 3  VERIFIED_OK → clasificación variante→ PRESENT_WITH/WITHOUT_PRICE · ABSENT(A4, sólo complete) · UNVERIFIED(R9)
 *   TIER 4  sin outcome → ausencia por sitemap  → ABSENT(A3, sólo ambos OK y ausente en ambos) · UNVERIFIED
 */
function classifyOne(
  row: ReconcileCatalogRow,
  ctx: {
    sitemapStart: Set<string>; sitemapEnd: Set<string>; sitemapStartOk: boolean; sitemapEndOk: boolean;
    fichaOutcomes: Map<string, FichaOutcomeInfo>; observedVariants: Map<string, ObservedVariant[]>;
    observedSkuToFichas: Map<string, Set<string>>; ambiguousMappingSkus: Set<string>;
  },
): SkuResult {
  const sku = row.sku;
  const F = row.fichaCanonicalUrl;

  // TIER 0 · mapping.
  if (F === null || F.trim() === "") return unverified(sku, "UNMAPPABLE_MAPPING");
  if (ctx.ambiguousMappingSkus.has(sku)) return unverified(sku, "AMBIGUOUS_MAPPING");

  const outcome = ctx.fichaOutcomes.get(F);
  const bothOk = ctx.sitemapStartOk && ctx.sitemapEndOk;
  const inStart = ctx.sitemapStart.has(F);
  const inEnd = ctx.sitemapEnd.has(F);
  const absentBoth = bothOk && !inStart && !inEnd;
  const drift = bothOk && ((inStart && !inEnd) || (!inStart && inEnd));

  // TIER 1 · outcome de FALLA → UNVERIFIED. Precede a TODA derivación de ausencia
  // (incluida la ausencia observada accidentalmente en un READ_FAILED — R16).
  if (outcome && (outcome.outcome === "RATE_LIMITED" || outcome.outcome === "READ_FAILED" || outcome.outcome === "DATA_INCOMPLETE")) {
    return unverified(sku, outcome.outcome);
  }

  // TIER 2 · EVIDENCE_CONFLICT (§2.1). Estados mutuamente incompatibles → UNVERIFIED.
  //  (a) ficha ausente en AMBOS snapshots válidos PERO existe outcome VERIFIED_OK (el walk se
  //      siembra del sitemap START: absent-en-START nunca se recorre) → conflicto.
  if (absentBoth && outcome && outcome.outcome === "VERIFIED_OK") {
    return unverified(sku, "EVIDENCE_CONFLICT", ["SITEMAP_ABSENT_BOTH", "FICHA_OUTCOME_VERIFIED_OK"]);
  }
  //  (b) el catálogo mapea el SKU a la ficha F, pero la evidencia observada lo asigna
  //      INEQUÍVOCAMENTE a otra ficha F' (una sola, distinta de F) → conflicto.
  const observedFichas = ctx.observedSkuToFichas.get(sku);
  if (observedFichas && observedFichas.size === 1 && !observedFichas.has(F)) {
    return unverified(sku, "EVIDENCE_CONFLICT", ["CATALOG_MAPPING", "OBSERVED_MAPPING"]);
  }

  // TIER 3 · ficha VERIFIED_OK → clasificación a nivel variante.
  if (outcome && outcome.outcome === "VERIFIED_OK") {
    const variants = ctx.observedVariants.get(F) ?? [];
    const observed = variants.find((v) => (v.sku ?? "").trim() === sku);
    if (observed) {
      return isPersistablePrice(observed.priceNumber)
        ? { sku, classification: "SKU_VERIFIED_PRESENT_WITH_PRICE", reason: null, evidenceLevel: "DIRECT_CAPTURE" } // A1
        : { sku, classification: "SKU_PRESENT_WITHOUT_PRICE", reason: null, evidenceLevel: "DIRECT_CAPTURE" };      // A2
    }
    // SKU histórico NO aparece en el set observado de una ficha VERIFIED_OK. La ausencia por
    // variante (A4) exige AMBOS witnesses: set de VARIANTES completo Y set de IDENTIDAD SKU completo.
    if (outcome.variantSetComplete !== true) {
      return unverified(sku, "VARIANT_SET_INCOMPLETE"); // R9 (NO_VARIANT_ABSENCE_WITHOUT_COMPLETE_SET)
    }
    if (outcome.skuIdentitySetComplete !== true) {
      // R18/R19: alguna variante fue retirada por cuarentena → su SKU tampoco aparece → falso ABSENT.
      return unverified(sku, "SKU_IDENTITY_SET_INCOMPLETE"); // NO_VARIANT_ABSENCE_WITHOUT_SKU_IDENTITY_COMPLETE
    }
    return { sku, classification: "SKU_VERIFIED_ABSENT", reason: "VARIANT_NOT_IN_COMPLETE_SET", evidenceLevel: "DIRECT_CAPTURE" }; // A4
  }

  // TIER 4 · sin outcome de ficha → ausencia por sitemap (A3), con dos testigos consistentes.
  if (!bothOk) return unverified(sku, "SITEMAP_UNAVAILABLE"); // R12
  if (drift) return unverified(sku, "SITEMAP_DRIFT");          // R10/R11
  if (absentBoth) {
    return { sku, classification: "SKU_VERIFIED_ABSENT", reason: "ABSENT_IN_BOTH_SITEMAPS", evidenceLevel: "SITEMAP_TWO_WITNESS" }; // A3
  }
  // Ficha presente en el sitemap pero sin evidencia de captura → no observado.
  return unverified(sku, "NOT_OBSERVED");
}

/** Clasifica todas las filas del catálogo y agrega el resumen + registro de conflictos. */
export function reconcileSkus(input: ReconcileInput): ReconcileResult {
  const ctx = {
    sitemapStart: input.sitemapStart,
    sitemapEnd: input.sitemapEnd,
    sitemapStartOk: input.sitemapStartOk,
    sitemapEndOk: input.sitemapEndOk,
    fichaOutcomes: input.fichaOutcomes,
    observedVariants: input.observedVariants,
    observedSkuToFichas: buildObservedSkuToFichas(input.observedVariants),
    ambiguousMappingSkus: input.ambiguousMappingSkus ?? new Set<string>(),
  };

  const results: SkuResult[] = [];
  const summary: ReconcileSummary = {
    total: 0, verifiedPresentWithPrice: 0, presentWithoutPrice: 0, verifiedAbsent: 0, unverified: 0, byReason: {},
  };
  const evidenceConflictSample: Array<{ sku: string; sources: [string, string] }> = [];
  let evidenceConflictCount = 0;

  for (const row of input.catalogRows) {
    const r = classifyOne(row, ctx);
    results.push(r);
    summary.total++;
    switch (r.classification) {
      case "SKU_VERIFIED_PRESENT_WITH_PRICE": summary.verifiedPresentWithPrice++; break;
      case "SKU_PRESENT_WITHOUT_PRICE": summary.presentWithoutPrice++; break;
      case "SKU_VERIFIED_ABSENT": summary.verifiedAbsent++; break;
      case "SKU_UNVERIFIED": summary.unverified++; break;
    }
    if (r.reason) summary.byReason[r.reason] = (summary.byReason[r.reason] ?? 0) + 1;
    if (r.reason === "EVIDENCE_CONFLICT") {
      evidenceConflictCount++;
      if (evidenceConflictSample.length < 10 && r.conflictSources) {
        evidenceConflictSample.push({ sku: r.sku, sources: r.conflictSources });
      }
    }
  }

  // §2 · providerDiscovery: SKUs observados en el proveedor SIN fila de catálogo (eje separado).
  const catalogSkus = new Set(input.catalogRows.map((r) => (r.sku ?? "").trim()).filter((s) => s !== ""));
  const newSkuFichas = new Map<string, Set<string>>(); // sku nuevo → fichas donde se observó
  for (const [ficha, variants] of input.observedVariants) {
    for (const v of variants) {
      const sku = (v.sku ?? "").trim();
      if (sku === "" || catalogSkus.has(sku)) continue;
      if (!newSkuFichas.has(sku)) newSkuFichas.set(sku, new Set());
      newSkuFichas.get(sku)!.add(ficha);
    }
  }
  const newProviderSkus = [...newSkuFichas.keys()].sort();
  const newFichas = new Set<string>();
  for (const fs of newSkuFichas.values()) for (const f of fs) newFichas.add(f);
  const providerDiscovery: ProviderDiscovery = {
    newProviderSkus,
    providerNewSkuCount: newProviderSkus.length,
    providerNewFichaCount: newFichas.size,
    newProviderSkusSample: newProviderSkus.slice(0, 20),
  };

  return { results, summary, evidenceConflictCount, evidenceConflictSample, providerDiscovery };
}
