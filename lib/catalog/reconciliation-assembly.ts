// 2G-R8-Q2.1-B · §3 — Ensamblado PURO de los inputs del clasificador a partir de la data cruda del
// partial-commit path (SkuFirstPartialResult) + el catálogo. Sin red, sin DB. Es el puente entre el
// scraper (observación) y reconcileSkus (clasificación), y computa los conteos de outcome por ficha
// que alimentan el RUN HEALTH GATE (§5).
//
// Claves canónicas consistentes: TODO se indexa por normalizeCatalogUrl(...) para que fichaOutcomes,
// observedVariants, fichaQuarantine y el catálogo coincidan (la identidad de ficha del catálogo es
// normalizeCatalogUrl(productUrl)).

import { normalizeCatalogUrl } from "../scraper/url-normalization";
import { buildCatalogSkuToFichaMap, fichaIdentity } from "../scraper/ficha-sku-map";
import {
  fichaSkuIdentitySetComplete,
  type ReconcileInput,
  type ReconcileCatalogRow,
  type FichaOutcomeInfo,
  type ObservedVariant,
  type FichaOutcome,
  type VariantSetComplete,
} from "./sku-reconciliation";

export interface AssemblyFichaObservation {
  url: string;
  outcome: FichaOutcome;
  variantSetComplete: VariantSetComplete;
}
export interface AssemblyProduct {
  sku: string | null;
  productUrl: string | null;
  wholesalePrice: number | null;
}
export interface AssemblyPartial {
  products: AssemblyProduct[];
  fichaObservations: AssemblyFichaObservation[];
  fichaQuarantine: Record<string, { count: number }>;
  sitemapStartUrls: string[];
  sitemapEndUrls: string[];
  sitemapStartOk: boolean;
  sitemapEndOk: boolean;
}
export interface AssemblyCatalogRow {
  sku: string;
  productUrl: string | null;
  wholesalePrice: number | null;
}

export interface FichaOutcomeCounts {
  verifiedOk: number;
  dataIncomplete: number;
  readFailed: number;
  rateLimited: number;
}

export interface AssemblyResult {
  input: ReconcileInput;
  catalogRows: ReconcileCatalogRow[];
  fichaOutcomeCounts: FichaOutcomeCounts;
  /** SKUs del catálogo mapeables (no colisión, ficha resoluble) — denominador del ratio de delisting. */
  eligibleMappedCatalogSkuCount: number;
}

export function assembleReconcileInput(partial: AssemblyPartial, catalog: AssemblyCatalogRow[]): AssemblyResult {
  // ── catálogo → filas de reconciliación (identidad canónica) ──
  const catalogRows: ReconcileCatalogRow[] = catalog.map((r) => ({
    sku: r.sku,
    fichaCanonicalUrl: fichaIdentity(r.productUrl),
    wholesalePrice: r.wholesalePrice,
  }));

  // ── mapping ambiguo (colisiones catálogo) ──
  const catMap = buildCatalogSkuToFichaMap(catalog.map((r) => ({ sku: r.sku, productUrl: r.productUrl })));
  const ambiguousMappingSkus = new Set(catMap.collisionSkus);
  // eligible = SKUs con ficha resoluble y sin colisión (excluye unmappable/ambiguos).
  const eligibleMappedCatalogSkuCount = Object.keys(catMap.skuToFicha).length;

  // ── cuarentena por ficha canónica ──
  const quarByFicha = new Map<string, number>();
  for (const [rawUrl, info] of Object.entries(partial.fichaQuarantine)) {
    const ficha = normalizeCatalogUrl(rawUrl) ?? rawUrl;
    quarByFicha.set(ficha, (quarByFicha.get(ficha) ?? 0) + info.count);
  }

  // ── fichaOutcomes (canónico) + conteos por outcome ──
  const fichaOutcomes = new Map<string, FichaOutcomeInfo>();
  const counts: FichaOutcomeCounts = { verifiedOk: 0, dataIncomplete: 0, readFailed: 0, rateLimited: 0 };
  for (const obs of partial.fichaObservations) {
    const ficha = normalizeCatalogUrl(obs.url) ?? obs.url;
    fichaOutcomes.set(ficha, {
      outcome: obs.outcome,
      variantSetComplete: obs.variantSetComplete,
      skuIdentitySetComplete: fichaSkuIdentitySetComplete(quarByFicha.get(ficha)),
    });
    switch (obs.outcome) {
      case "VERIFIED_OK": counts.verifiedOk++; break;
      case "DATA_INCOMPLETE": counts.dataIncomplete++; break;
      case "READ_FAILED": counts.readFailed++; break;
      case "RATE_LIMITED": counts.rateLimited++; break;
    }
  }

  // ── observedVariants (canónico) desde los productos agrupados ──
  const observedVariants = new Map<string, ObservedVariant[]>();
  for (const p of partial.products) {
    const sku = (p.sku ?? "").trim();
    if (sku === "") continue;
    const ficha = fichaIdentity(p.productUrl) ?? (p.productUrl ?? "");
    if (ficha === "") continue;
    if (!observedVariants.has(ficha)) observedVariants.set(ficha, []);
    observedVariants.get(ficha)!.push({ sku, priceNumber: p.wholesalePrice });
  }

  const input: ReconcileInput = {
    catalogRows,
    sitemapStart: new Set(partial.sitemapStartUrls.map((u) => normalizeCatalogUrl(u) ?? u)),
    sitemapEnd: new Set(partial.sitemapEndUrls.map((u) => normalizeCatalogUrl(u) ?? u)),
    sitemapStartOk: partial.sitemapStartOk,
    sitemapEndOk: partial.sitemapEndOk,
    fichaOutcomes,
    observedVariants,
    ambiguousMappingSkus,
  };

  return { input, catalogRows, fichaOutcomeCounts: counts, eligibleMappedCatalogSkuCount };
}
