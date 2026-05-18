// Motor de cálculo de precios. Pure function: dado un producto y un set de
// reglas activas, decide qué regla aplicar y qué precio resulta.
//
// Prioridad (de mayor a menor):
//   1. manualMargin del producto
//   2. Regla de CATEGORY que coincida con assignedCategoryId
//   3. Regla de PROVIDER que coincida con providerId
//   4. Regla GLOBAL
// Empate dentro del mismo scope: mayor `priority` gana.

import type { PricingRuleScope, RoundingMode } from "@prisma/client";

export interface PricingResult {
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
}

const EMPTY_RESULT: PricingResult = {
  calculatedPrice: null,
  effectivePrice: null,
  marginPercent: null,
  ruleApplied: "none",
  ruleName: null,
  ruleId: null,
};

export function resolvePricing(
  product: PricingProductInput,
  rules: PricingRuleForCalc[]
): PricingResult {
  const finalPrice =
    product.finalPrice != null ? Number(product.finalPrice) : null;
  const cost =
    product.wholesalePrice != null ? Number(product.wholesalePrice) : null;

  // Caso degenerado: sin costo. Si hay finalPrice set, lo respetamos como
  // override puro (sin regla atribuida); si no, todo en null.
  if (cost == null || !Number.isFinite(cost) || cost <= 0) {
    return {
      ...EMPTY_RESULT,
      effectivePrice: finalPrice,
    };
  }

  const wrap = (
    partial: Omit<PricingResult, "effectivePrice">
  ): PricingResult => ({
    ...partial,
    effectivePrice: finalPrice ?? partial.calculatedPrice,
  });

  // 1. Margen manual del producto (no requiere regla, redondeo NONE)
  if (product.manualMargin != null) {
    return wrap({
      calculatedPrice: applyMarkup(cost, product.manualMargin, "NONE"),
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
        calculatedPrice: applyMarkup(cost, cat.marginPercent, cat.roundingMode),
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
      calculatedPrice: applyMarkup(cost, prov.marginPercent, prov.roundingMode),
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
      calculatedPrice: applyMarkup(cost, global.marginPercent, global.roundingMode),
      marginPercent: global.marginPercent,
      ruleApplied: "global",
      ruleName: global.name,
      ruleId: global.id,
    });
  }

  // Sin regla pero con finalPrice → respetar el override.
  return { ...EMPTY_RESULT, effectivePrice: finalPrice };
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
