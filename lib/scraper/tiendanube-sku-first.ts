// GATE A2 — Different Touch (TiendaNube/Nuvemshop) extractor SKU-first.
//
// Módulo PURO: sin DB, sin red, sin Playwright, sin credenciales. Toma filas
// reducidas de `window.LS.variants` (una por variante), las agrupa por
// `sku.trim()` (SKU-first: 1 sku = 1 producto) y produce `ScrapedProduct[]`.
//
// Reglas duras (heredadas de Gate A1):
//  - El SKU se normaliza SOLO con String(rawSku).trim(). No lower/upper, no
//    colapso de espacios internos, no strip de caracteres. Case-sensitive.
//  - Los IDs externos (product_id / variant id) se validan con /^[1-9]\d*$/ y
//    se ordenan como BigInt (nunca Number, nunca lexicográfico). Se serializan
//    SIEMPRE como string en rawData (JSON-safe, sin BigInt).
//  - El SKU NUNCA se deriva de variantId ni productId.
//  - Ganador determinístico: productId(BigInt asc) → variantId(BigInt asc) →
//    originalCaptureIndex(asc). IDs inválidos al final, entre sí por índice.
//  - wholesalePrice = priceNumber (BRUTO con IVA), con fallback intra-grupo.
//  - stock del producto agrupado SIEMPRE null (el stock por variante no compone
//    un stock de producto en modo SKU-first).
//
// Nada aquí conoce Provider, dominio, providerId ni ProviderType: el modo se
// activa únicamente por config explícita en el orquestador.

import type { ScrapedProduct } from "./scraper.service";
import { normalizeSupplierTaxonomy } from "./tiendanube-taxonomy";

// ─────────────────────────────────────────────────────────────────────────────
// Tipos
// ─────────────────────────────────────────────────────────────────────────────

/** Fila reducida (una por variante) tal como la produce el capture de Gate 1C. */
export interface TnReducedRow {
  sourcePageIndex: number | null;
  sourceVariantIndex: number | null;
  productId: string | number | null;
  variantId: string | number | null;
  rawSku: string | null;
  productName: string | null;
  variantName?: string | null;
  productUrl: string | null;
  imageUrl: string | null;
  priceNumber: number | null;
  priceWithoutTaxes: string | null;
  stock: number | string | null;
  available: boolean | null;
  variantAttributes?: Record<string, string> | null;
  [k: string]: unknown;
}

export interface QuarantineEntry {
  reason: "MISSING_SKU" | "NO_USABLE_NAME";
  trimmedSku: string | null;
  originalCaptureIndex: number;
  productId: string | null;
  variantId: string | null;
}

export interface GroupDiagnostics {
  totalRows: number;
  quarantineCount: number;
  productCount: number;
  variantsPreserved: number;
  repeatedGroups: number;
  sameParentGroups: number;
  crossProductGroups: number;
  invalidGroups: number;
  crossProductSetKeys: string[];
  crossProductSetCount: number;
  invalidExternalIdRows: number;
  priceParseErrorRows: number;
  missingGrossGroups: number;
  missingImageGroups: number;
  priceUnitVerdict: "PESOS_CONFIRMED" | "PRICE_UNIT_UNCONFIRMED";
  priceUnitValidPairs: number;
  priceUnitMedianRatio: number | null;
}

export interface GroupResult {
  products: ScrapedProduct[];
  quarantine: QuarantineEntry[];
  diagnostics: GroupDiagnostics;
}

// ─────────────────────────────────────────────────────────────────────────────
// Resolución del modo de extracción (activación explícita, sin inferencia)
// ─────────────────────────────────────────────────────────────────────────────

export type ExtractionMode = "LEGACY" | "TIENDANUBE_LS_VARIANTS_SKU_FIRST";

/**
 * Resuelve el modo de extracción a partir de un valor de config crudo (A3-P1: fail-loud).
 *   null | undefined | "" | solo-whitespace   → LEGACY (sin warning, sin throw).
 *   input que NO es string (y no null/undefined) → LEGACY (sin warning). El endurecimiento
 *     de inputs no-string queda diferido: en runtime Prisma `extractionMode` es string|null,
 *     así que ese caso no es alcanzable por el camino productivo
 *     (NON_STRING_EXTRACTION_MODE_BEHAVIOR = PRESERVED_LEGACY_DEFERRED).
 *   "TIENDANUBE_LS_VARIANTS_SKU_FIRST" (exacto) → modo nuevo.
 *   cualquier otro string NO vacío → throw fail-loud. Un valor mal tipeado NUNCA cae en
 *     silencio a legacy; `trim()` se usa SOLO para detectar blank, nunca normaliza
 *     (" TIENDANUBE_LS_VARIANTS_SKU_FIRST " lanza, no se recorta al valor reconocido).
 * NUNCA infiere el modo por nombre, dominio, providerId ni ProviderType.
 * `warning` NUNCA se emite (WARNING_NORMALIZATION_DIRECTION = PROPERTY_ABSENT_UNIVERSAL):
 * ningún retorno no-excepcional contiene la clave `warning` (`"warning" in result === false`).
 * El tipo la conserva OPCIONAL solo por compatibilidad de forma con el caller congelado, cuya
 * rama `if (resolvedMode.warning)` queda como dead code deliberado (no se limpia).
 */
export function resolveExtractionMode(value: unknown): { mode: ExtractionMode; warning?: string | null } {
  if (value === null || value === undefined) return { mode: "LEGACY" };
  // Type guard ANTES de toda coerción a string: evita que String(1)/String({}) → "1"/"[object Object]"
  // caigan en el throw. Inputs no-string quedan en legacy (deferido).
  if (typeof value !== "string") return { mode: "LEGACY" };
  if (value.trim() === "") return { mode: "LEGACY" };
  if (value === "TIENDANUBE_LS_VARIANTS_SKU_FIRST") {
    return { mode: "TIENDANUBE_LS_VARIANTS_SKU_FIRST" };
  }
  // String no vacío desconocido → fail-loud. JSON.stringify hace visible el whitespace circundante.
  throw new Error(
    `extractionMode inválido: field=extractionMode valor recibido=${JSON.stringify(value)}`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Parser de precio argentino: "$6.800,00" → 6800 · "." miles, "," decimal
// ─────────────────────────────────────────────────────────────────────────────

export function parseArgArsPrice(raw: unknown): { raw: unknown; number: number | null; error: boolean } {
  if (raw === null || raw === undefined) return { raw, number: null, error: false };
  const s = String(raw).trim();
  if (s === "") return { raw, number: null, error: false };
  // Descartar todo lo que no sea dígito, punto o coma (símbolo $, "ARS", espacios).
  const cleaned = s.replace(/[^\d.,]/g, "");
  if (cleaned === "") return { raw, number: null, error: true };
  // Formato AR válido: miles agrupados de a 3 con "." y decimal opcional con ",".
  // Se acepta también el caso sin miles ("6800", "6800,50").
  if (!/^(\d{1,3}(\.\d{3})+|\d+)(,\d+)?$/.test(cleaned)) {
    return { raw, number: null, error: true };
  }
  const normalized = cleaned.replace(/\./g, "").replace(",", ".");
  const n = Number(normalized);
  if (!Number.isFinite(n)) return { raw, number: null, error: true };
  return { raw, number: n, error: false };
}

// ─────────────────────────────────────────────────────────────────────────────
// Validación de IDs externos: decimal positivo, siempre string
// ─────────────────────────────────────────────────────────────────────────────

export function normalizeExternalId(v: unknown): { valid: boolean; str: string | null } {
  if (v === null || v === undefined) return { valid: false, str: null };
  const s = typeof v === "string" ? v.trim() : String(v);
  if (!/^[1-9]\d*$/.test(s)) return { valid: false, str: null };
  return { valid: true, str: s };
}

// ─────────────────────────────────────────────────────────────────────────────
// Mapeo crudo → reducido (Gate 1C). Reconstruido y reusado; probado contra la
// muestra "017-30". Sin acceso a red/DOM: recibe la variante cruda ya extraída.
// ─────────────────────────────────────────────────────────────────────────────

interface RawLsVariant {
  id?: unknown;
  product_id?: unknown;
  sku?: unknown;
  option0?: unknown;
  option1?: unknown;
  option2?: unknown;
  price_short?: unknown;
  price_long?: unknown;
  price_number?: unknown;
  price_number_raw?: unknown;
  price_without_taxes?: unknown;
  promotional_price_number?: unknown;
  stock?: unknown;
  available?: unknown;
  image?: unknown;
  image_url?: unknown;
}

interface MapCtx {
  sourcePageIndex: number;
  sourceVariantIndex: number;
  productId: unknown;
  productName: string | null;
  productUrl: string | null;
  domLabels: (string | null)[];
  capturedAt: string;
}

function slugFromUrl(url: string | null): string | null {
  if (!url) return null;
  const noQuery = url.split("?")[0].split("#")[0];
  const parts = noQuery.split("/").filter((p) => p !== "");
  return parts.length ? parts[parts.length - 1] : null;
}

function asStringOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function asNumberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function mapLsVariantToReducedRow(rawVariant: RawLsVariant, ctx: MapCtx): Record<string, unknown> {
  const rawSku = typeof rawVariant.sku === "string" ? rawVariant.sku : null;
  const trimmedSku = rawSku === null ? null : rawSku.trim();

  const option0Value = asStringOrNull(rawVariant.option0);
  const option1Value = asStringOrNull(rawVariant.option1);
  const option2Value = asStringOrNull(rawVariant.option2);
  const option0Name = ctx.domLabels[0] ?? null;
  const option1Name = ctx.domLabels[1] ?? null;
  const option2Name = ctx.domLabels[2] ?? null;

  const variantAttributes: Record<string, string> = {};
  const optionPairs: [string | null, string | null][] = [
    [option0Name, option0Value],
    [option1Name, option1Value],
    [option2Name, option2Value],
  ];
  optionPairs.forEach(([name, value], i) => {
    if (value !== null) variantAttributes[name ?? `option${i}`] = value;
  });
  const attrValues = optionPairs.map(([, v]) => v).filter((v): v is string => v !== null);

  const productName = ctx.productName;
  const variantName = productName === null ? null : productName + (attrValues.length ? " - " + attrValues.join(" / ") : "");

  return {
    sourcePageIndex: ctx.sourcePageIndex,
    sourceVariantIndex: ctx.sourceVariantIndex,
    capturedAt: ctx.capturedAt,
    productId: asNumberOrNull(ctx.productId) ?? ctx.productId ?? null,
    variantId: asNumberOrNull(rawVariant.id) ?? rawVariant.id ?? null,
    rawSku,
    trimmedSku,
    productName,
    variantName,
    productUrl: ctx.productUrl,
    option0Name,
    option0Value,
    option1Name,
    option1Value,
    option2Name,
    option2Value,
    variantAttributes,
    priceNumber: asNumberOrNull(rawVariant.price_number),
    priceNumberRaw: asNumberOrNull(rawVariant.price_number_raw),
    priceShort: asStringOrNull(rawVariant.price_short),
    priceLong: asStringOrNull(rawVariant.price_long),
    priceWithoutTaxes: asStringOrNull(rawVariant.price_without_taxes),
    priceWithoutTaxesNumber: null,
    priceWithoutTaxesRaw: null,
    promotionalPriceNumber: asNumberOrNull(rawVariant.promotional_price_number),
    stock: rawVariant.stock === null || rawVariant.stock === undefined ? null : (rawVariant.stock as number),
    available: typeof rawVariant.available === "boolean" ? rawVariant.available : null,
    imageId: asNumberOrNull(rawVariant.image),
    imageUrl: asStringOrNull(rawVariant.image_url),
    barcode: null,
    handle: null,
    productHandle: slugFromUrl(ctx.productUrl),
    descriptionSnippet: null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Agrupación SKU-first
// ─────────────────────────────────────────────────────────────────────────────

interface Member {
  row: TnReducedRow;
  originalCaptureIndex: number;
  productIdStr: string | null;
  variantIdStr: string | null;
  idsValid: boolean;
}

function bigCompare(a: string, b: string): number {
  const x = BigInt(a);
  const y = BigInt(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Orden determinístico del ganador dentro de un grupo. */
function sortMembers(members: Member[]): Member[] {
  return [...members].sort((m1, m2) => {
    if (m1.idsValid && m2.idsValid) {
      const p = bigCompare(m1.productIdStr as string, m2.productIdStr as string);
      if (p !== 0) return p;
      const v = bigCompare(m1.variantIdStr as string, m2.variantIdStr as string);
      if (v !== 0) return v;
      return m1.originalCaptureIndex - m2.originalCaptureIndex;
    }
    if (m1.idsValid !== m2.idsValid) return m1.idsValid ? -1 : 1; // válidos primero
    return m1.originalCaptureIndex - m2.originalCaptureIndex; // inválidos entre sí
  });
}

function firstNonEmptyString(candidates: (unknown)[]): string | null {
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() !== "") return c;
  }
  return null;
}

function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function groupSkuFirst(
  rows: TnReducedRow[],
  // C1 · Mapa ADITIVO/opcional sourcePageIndex → breadcrumb crudo de esa ficha. Sólo alimenta la
  // observación de taxonomía (`supplierTaxonomy`). Ausente ⇒ taxonomía NOT_OBSERVED (null). No afecta
  // agrupación, precio, SKU, imagen ni ninguna salida existente.
  breadcrumbByPage?: ReadonlyMap<number, ReadonlyArray<string | null> | null>,
): GroupResult {
  const quarantine: QuarantineEntry[] = [];
  const groups = new Map<string, Member[]>();
  const groupOrder: string[] = [];
  let invalidExternalIdRows = 0;
  let priceParseErrorRows = 0;

  rows.forEach((row, originalCaptureIndex) => {
    const trimmedSku = row.rawSku === null || row.rawSku === undefined ? null : String(row.rawSku).trim();
    const pid = normalizeExternalId(row.productId);
    const vid = normalizeExternalId(row.variantId);
    const idsValid = pid.valid && vid.valid;
    if (!idsValid) invalidExternalIdRows++;
    if (row.priceWithoutTaxes != null && String(row.priceWithoutTaxes).trim() !== "" && parseArgArsPrice(row.priceWithoutTaxes).error) {
      priceParseErrorRows++;
    }

    if (trimmedSku === null || trimmedSku === "") {
      quarantine.push({
        reason: "MISSING_SKU",
        trimmedSku: null,
        originalCaptureIndex,
        productId: pid.str,
        variantId: vid.str,
      });
      return;
    }

    const member: Member = {
      row,
      originalCaptureIndex,
      productIdStr: pid.str,
      variantIdStr: vid.str,
      idsValid,
    };
    if (!groups.has(trimmedSku)) {
      groups.set(trimmedSku, []);
      groupOrder.push(trimmedSku);
    }
    groups.get(trimmedSku)!.push(member);
  });

  const products: ScrapedProduct[] = [];
  let repeatedGroups = 0;
  let sameParentGroups = 0;
  let crossProductGroups = 0;
  let invalidGroups = 0;
  let missingGrossGroups = 0;
  let missingImageGroups = 0;
  const crossProductSetKeys = new Set<string>();
  const ratioSamples: number[] = [];

  // Muestreo de ratio bruto/neto para confirmar unidad de precio (misma variante).
  for (const row of rows) {
    const gross = typeof row.priceNumber === "number" && Number.isFinite(row.priceNumber) ? row.priceNumber : null;
    const net = parseArgArsPrice(row.priceWithoutTaxes);
    if (gross !== null && gross > 0 && net.number !== null && net.number > 0) {
      ratioSamples.push(gross / net.number);
    }
  }
  const medianRatio = median(ratioSamples);
  const priceUnitVerdict: GroupDiagnostics["priceUnitVerdict"] =
    medianRatio !== null && medianRatio >= 1.0 && medianRatio <= 1.3 ? "PESOS_CONFIRMED" : "PRICE_UNIT_UNCONFIRMED";

  // Orden determinístico de emisión: por trimmedSku (para independencia del orden de entrada).
  const orderedSkus = [...groupOrder].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  for (const trimmedSku of orderedSkus) {
    const members = groups.get(trimmedSku)!;
    const sorted = sortMembers(members);
    const winner = sorted[0];

    const uniqueProductIds = Array.from(
      new Set(sorted.filter((m) => m.idsValid && m.productIdStr).map((m) => m.productIdStr as string)),
    ).sort(bigCompare);

    const allInvalid = uniqueProductIds.length === 0;
    let classification: "SINGLE" | "SAME_PARENT" | "CROSS_PRODUCT_CONFLICT" | "INVALID_IDS";
    if (allInvalid) classification = "INVALID_IDS";
    else if (uniqueProductIds.length > 1) classification = "CROSS_PRODUCT_CONFLICT";
    else if (members.length > 1) classification = "SAME_PARENT";
    else classification = "SINGLE";

    if (members.length > 1) repeatedGroups++;
    if (classification === "SAME_PARENT") sameParentGroups++;
    if (classification === "CROSS_PRODUCT_CONFLICT") {
      crossProductGroups++;
      crossProductSetKeys.add(uniqueProductIds.join("::"));
    }
    if (classification === "INVALID_IDS") invalidGroups++;

    // Nombre: ganador, luego primer miembro con nombre usable.
    const name = firstNonEmptyString([winner.row.productName, ...sorted.map((m) => m.row.productName)]);
    if (name === null) {
      quarantine.push({
        reason: "NO_USABLE_NAME",
        trimmedSku,
        originalCaptureIndex: winner.originalCaptureIndex,
        productId: winner.productIdStr,
        variantId: winner.variantIdStr,
      });
      continue;
    }

    const flags: string[] = [];

    // wholesalePrice = BRUTO (priceNumber). Ganador, luego fallback intra-grupo.
    let wholesalePrice: number | null = null;
    for (const m of sorted) {
      const p = m.row.priceNumber;
      if (typeof p === "number" && Number.isFinite(p) && p > 0) {
        wholesalePrice = p;
        break;
      }
    }
    if (wholesalePrice === null) {
      flags.push("MISSING_GROSS_PRICE");
      missingGrossGroups++;
    }

    // Neto del ganador (informativo, para caracterización).
    const netParsed = parseArgArsPrice(winner.row.priceWithoutTaxes);
    if (netParsed.error) flags.push("NET_PRICE_PARSE_ERROR");
    const priceWithoutTaxes = netParsed.number;

    // Imagen: ganador, luego fallback.
    const imageUrl = firstNonEmptyString([winner.row.imageUrl, ...sorted.map((m) => m.row.imageUrl)]);
    if (imageUrl === null) {
      flags.push("MISSING_IMAGE");
      missingImageGroups++;
    }

    if (classification === "CROSS_PRODUCT_CONFLICT") flags.push("CROSS_PRODUCT_CONFLICT");
    if (classification === "INVALID_IDS") flags.push("INVALID_EXTERNAL_IDS");

    const availableAny = sorted.some((m) => m.row.available === true);
    const availableAll = sorted.every((m) => m.row.available === true);

    const rawVariants = sorted.map((m) => ({
      productId: m.productIdStr,
      variantId: m.variantIdStr,
      idsValid: m.idsValid,
      rawSku: m.row.rawSku ?? null,
      trimmedSku,
      sourcePageIndex: m.row.sourcePageIndex ?? null,
      sourceVariantIndex: m.row.sourceVariantIndex ?? null,
      originalCaptureIndex: m.originalCaptureIndex,
      priceNumber: typeof m.row.priceNumber === "number" ? m.row.priceNumber : null,
      priceWithoutTaxes: typeof m.row.priceWithoutTaxes === "string" ? m.row.priceWithoutTaxes : null,
      available: typeof m.row.available === "boolean" ? m.row.available : null,
      imageUrl: typeof m.row.imageUrl === "string" ? m.row.imageUrl : null,
      variantAttributes: m.row.variantAttributes ?? null,
    }));

    const rawData: Record<string, unknown> = {
      source: "TIENDANUBE_LS_VARIANTS_SKU_FIRST",
      trimmedSku,
      groupType: classification,
      classification,
      memberCount: members.length,
      canonicalWinner: {
        productId: winner.productIdStr,
        variantId: winner.variantIdStr,
        originalCaptureIndex: winner.originalCaptureIndex,
      },
      crossProductSetKey: uniqueProductIds.join("::"),
      crossProductProductIds: uniqueProductIds,
      wholesalePriceSource: "GROSS_WITH_VAT",
      priceWithoutTaxes,
      availableAny,
      availableAll,
      flags,
      variants: rawVariants,
    };

    // C1 · Observación ADITIVA de taxonomía. Los SKU hermanos comparten la ficha (sourcePageIndex)
    // → misma ruta. Se resuelve el breadcrumb de la ficha del ganador. NO toca `category` (legacy null).
    const winnerPageIndex = typeof winner.row.sourcePageIndex === "number" ? winner.row.sourcePageIndex : null;
    const supplierTaxonomy = normalizeSupplierTaxonomy(
      winnerPageIndex !== null ? breadcrumbByPage?.get(winnerPageIndex) ?? null : null,
    );

    products.push({
      sku: trimmedSku,
      name,
      description: null,
      wholesalePrice,
      oldPrice: null,
      stock: null, // producto agrupado: SIEMPRE null en modo SKU-first
      category: null,
      brand: null,
      productUrl: typeof winner.row.productUrl === "string" ? winner.row.productUrl : null,
      imageUrl,
      rawData,
      externalProductId: winner.productIdStr,
      externalVariantId: winner.variantIdStr,
      supplierTaxonomy,
    });
  }

  const variantsPreserved = products.reduce(
    (acc, p) => acc + (((p.rawData as { variants?: unknown[] }).variants?.length) ?? 0),
    0,
  );

  const diagnostics: GroupDiagnostics = {
    totalRows: rows.length,
    quarantineCount: quarantine.length,
    productCount: products.length,
    variantsPreserved,
    repeatedGroups,
    sameParentGroups,
    crossProductGroups,
    invalidGroups,
    crossProductSetKeys: Array.from(crossProductSetKeys).sort(),
    crossProductSetCount: crossProductSetKeys.size,
    invalidExternalIdRows,
    priceParseErrorRows,
    missingGrossGroups,
    missingImageGroups,
    priceUnitVerdict,
    priceUnitValidPairs: ratioSamples.length,
    priceUnitMedianRatio: medianRatio,
  };

  return { products, quarantine, diagnostics };
}
