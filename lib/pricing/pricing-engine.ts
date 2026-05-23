// Motor de cálculo de precios. Pure function: dado un producto + descuento
// sobre lista del proveedor + set de reglas activas, decide qué regla aplicar
// y qué precio resulta.
//
// Pipeline:
//   1. effectiveCost = wholesalePrice × (1 − listDiscountPercent/100)
//   2. Decide la regla a aplicar:
//      a. manualMargin del producto
//      b. Regla de CATEGORY que coincida con assignedCategoryId
//      c. Regla de PROVIDER que coincida con providerId
//      d. Regla GLOBAL
//   3. calculatedPrice = effectiveCost × (1 + margin/100), con redondeo según regla.
//   4. effectivePrice = finalPrice override del usuario, o el calculatedPrice.
//
// Empate dentro del mismo scope: mayor `priority` gana.

import type { PricingRuleScope, RoundingMode } from "@prisma/client";

export interface PricingResult {
  /// Precio bruto del proveedor (no se modifica). Sirve para mostrar el
  /// desglose en el drawer cuando hay descuento sobre lista.
  wholesalePrice: number | null;
  /// Descuento sobre lista del proveedor (0 si no aplica).
  listDiscountPercent: number;
  /// wholesalePrice × (1 − listDiscountPercent/100). Base efectiva sobre la
  /// que se aplica el margen.
  effectiveCost: number | null;
  /// Precio calculado por el motor (effectiveCost × (1 + margin/100), con
  /// redondeo). Null si no hay regla o costo.
  calculatedPrice: number | null;
  /// Precio de venta efectivo: finalPrice (override del usuario) si está,
  /// caso contrario el calculatedPrice del motor.
  effectivePrice: number | null;
  marginPercent: number | null;
  ruleApplied: "manual" | "category" | "provider" | "global" | "none";
  ruleName: string | null;
  ruleId: string | null;
}

export interface PricingRuleForCalc {
  id: string;
  name: string;
  scope: PricingRuleScope;
  scopeId: string | null;
  marginPercent: number;
  roundingMode: RoundingMode;
  isActive: boolean;
  priority: number;
}

export interface PricingProductInput {
  wholesalePrice: number | null;
  manualMargin: number | null;
  /// Override de precio final fijado por el usuario. Si está set,
  /// `effectivePrice = finalPrice` aunque el motor calcule otra cosa.
  finalPrice?: number | null;
  assignedCategoryId: string | null;
  providerId: string;
  /// Descuento sobre lista del proveedor (0-100). Si está, el motor calcula
  /// `effectiveCost = wholesalePrice × (1 − listDiscountPercent/100)` y aplica
  /// el margen sobre eso. Si es null/undefined/0, se usa wholesalePrice tal cual.
  listDiscountPercent?: number | null;
}

function emptyResult(
  wholesalePrice: number | null,
  listDiscountPercent: number
): PricingResult {
  return {
    wholesalePrice,
    listDiscountPercent,
    effectiveCost: null,
    calculatedPrice: null,
    effectivePrice: null,
    marginPercent: null,
    ruleApplied: "none",
    ruleName: null,
    ruleId: null,
  };
}

export function resolvePricing(
  product: PricingProductInput,
  rules: PricingRuleForCalc[]
): PricingResult {
  const finalPrice =
    product.finalPrice != null ? Number(product.finalPrice) : null;
  const wholesale =
    product.wholesalePrice != null ? Number(product.wholesalePrice) : null;
  const rawDiscount =
    product.listDiscountPercent != null
      ? Number(product.listDiscountPercent)
      : 0;
  // Sanitize: ignore NaN, negative o > 100. Aceptamos 0..100 inclusive.
  const discount =
    Number.isFinite(rawDiscount) && rawDiscount > 0
      ? Math.min(rawDiscount, 100)
      : 0;

  // Caso degenerado: sin costo. Si hay finalPrice set, lo respetamos como
  // override puro (sin regla atribuida); si no, todo en null.
  if (wholesale == null || !Number.isFinite(wholesale) || wholesale <= 0) {
    return {
      ...emptyResult(wholesale, discount),
      effectivePrice: finalPrice,
    };
  }

  const effectiveCost =
    Math.round(wholesale * (1 - discount / 100) * 100) / 100;

  const wrap = (
    partial: Pick<
      PricingResult,
      "calculatedPrice" | "marginPercent" | "ruleApplied" | "ruleName" | "ruleId"
    >
  ): PricingResult => ({
    wholesalePrice: wholesale,
    listDiscountPercent: discount,
    effectiveCost,
    calculatedPrice: partial.calculatedPrice,
    effectivePrice: finalPrice ?? partial.calculatedPrice,
    marginPercent: partial.marginPercent,
    ruleApplied: partial.ruleApplied,
    ruleName: partial.ruleName,
    ruleId: partial.ruleId,
  });

  // 1. Margen manual del producto (no requiere regla, redondeo NONE)
  if (product.manualMargin != null) {
    return wrap({
      calculatedPrice: applyMarkup(effectiveCost, product.manualMargin, "NONE"),
      marginPercent: product.manualMargin,
      ruleApplied: "manual",
      ruleName: "Margen manual",
      ruleId: null,
    });
  }

  // 2. Regla por categoría
  if (product.assignedCategoryId) {
    const cat = pickRule(rules, "CATEGORY", product.assignedCategoryId);
    if (cat) {
      return wrap({
        calculatedPrice: applyMarkup(
          effectiveCost,
          cat.marginPercent,
          cat.roundingMode
        ),
        marginPercent: cat.marginPercent,
        ruleApplied: "category",
        ruleName: cat.name,
        ruleId: cat.id,
      });
    }
  }

  // 3. Regla por proveedor
  const prov = pickRule(rules, "PROVIDER", product.providerId);
  if (prov) {
    return wrap({
      calculatedPrice: applyMarkup(
        effectiveCost,
        prov.marginPercent,
        prov.roundingMode
      ),
      marginPercent: prov.marginPercent,
      ruleApplied: "provider",
      ruleName: prov.name,
      ruleId: prov.id,
    });
  }

  // 4. Regla global
  const global = pickRule(rules, "GLOBAL", null);
  if (global) {
    return wrap({
      calculatedPrice: applyMarkup(
        effectiveCost,
        global.marginPercent,
        global.roundingMode
      ),
      marginPercent: global.marginPercent,
      ruleApplied: "global",
      ruleName: global.name,
      ruleId: global.id,
    });
  }

  // Sin regla pero con finalPrice → respetar el override.
  return {
    ...emptyResult(wholesale, discount),
    effectiveCost,
    effectivePrice: finalPrice,
  };
}

function pickRule(
  rules: PricingRuleForCalc[],
  scope: PricingRuleScope,
  scopeId: string | null
): PricingRuleForCalc | undefined {
  return rules
    .filter(
      (r) =>
        r.isActive &&
        r.scope === scope &&
        (scope === "GLOBAL" ? r.scopeId == null : r.scopeId === scopeId)
    )
    .sort((a, b) => b.priority - a.priority)[0];
}

export function applyMarkup(
  cost: number,
  marginPercent: number,
  rounding: RoundingMode
): number {
  const raw = cost * (1 + marginPercent / 100);
  return applyRounding(raw, rounding);
}

function applyRounding(value: number, mode: RoundingMode): number {
  switch (mode) {
    case "CEIL":
      // Entero superior: 1075.45 → 1076
      return Math.ceil(value);
    case "NEAREST_100":
      return Math.round(value / 100) * 100;
    case "NEAREST_500":
      return Math.round(value / 500) * 500;
    case "ENDING_990":
      // Redondea al múltiplo de 1000 inferior y suma 990 → ej: 1234 → 990, 5678 → 5990
      return Math.floor(value / 1000) * 1000 + 990;
    case "NONE":
    default:
      return Math.round(value * 100) / 100;
  }
}
