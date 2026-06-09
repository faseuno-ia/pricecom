// D1 — detección de drift por cambio de regla de pricing.
//
// Cuando se crea/edita/borra una PricingRule, los productos publicados bajo su
// scope pueden quedar con un precio calculado distinto al snapshot priceInStore
// (es decir: PricEcom recalcula pero Woo quedó viejo). Este helper:
//   1. resuelve los catalogProductIds afectados por el/los scope(s) de la regla,
//   2. reusa markPublicationsDrift, que reevalúa cada publication ACTIVE con las
//      reglas ACTUALES y marca OUTDATED + pendingSync SOLO si hay drift real
//      (tolerancia $0.50). Sobre-incluir es seguro: los overridden o no-drift
//      recomputan igual y no se marcan.
//   3. emite EventLog PRICING_RULE_CHANGED (la causa a nivel regla; el
//      PRODUCT_MARKED_OUTDATED genérico lo emite markPublicationsDrift).
//
// IMPORTANTE (orden): el caller debe llamar a este helper DESPUÉS de commitear
// el write de la regla (create/update/delete), para que markPublicationsDrift
// recompute con el estado nuevo. En PATCH pasar el scope viejo Y el nuevo; en
// DELETE pasar el scope borrado + los ids linkeados (capturados ANTES del delete,
// porque el delete pone pricingRuleId=null).
//
// Extraído a lib para ser testeable con prisma inyectado (los route handlers
// usan el prisma de prod y no se testean directo).

import type { PrismaClient, PricingRuleScope } from "@prisma/client";
import { markPublicationsDrift } from "@/lib/catalog/mark-publications-drift";
import { logInfo } from "@/lib/events/event-log";

export interface RuleScopeRef {
  scope: PricingRuleScope;
  scopeId: string | null;
}

export interface MarkDriftForRuleChangeParams {
  userId: string;
  ruleId: string;
  action: "created" | "updated" | "deleted";
  /** Scopes a re-evaluar. PATCH: [viejo, nuevo]; CREATE: [nuevo]; DELETE: [borrado]. */
  scopes: RuleScopeRef[];
  /** DELETE: ids linkeados por pricingRuleId, capturados ANTES del delete. */
  extraCatalogProductIds?: string[];
  ruleName: string;
  marginPercentOld?: number | null;
  marginPercentNew?: number | null;
}

export interface MarkDriftForRuleChangeResult {
  /** catalogProductIds únicos considerados (cota superior de afectados). */
  affectedEvaluated: number;
  /** publications efectivamente marcadas OUTDATED (drift real). */
  markedOutdated: number;
}

const ACTION_LABEL: Record<MarkDriftForRuleChangeParams["action"], string> = {
  created: "creada",
  updated: "actualizada",
  deleted: "eliminada",
};

export async function markDriftForRuleChange(
  prisma: PrismaClient,
  params: MarkDriftForRuleChangeParams
): Promise<MarkDriftForRuleChangeResult> {
  const { userId, ruleId, action, scopes, extraCatalogProductIds = [], ruleName } = params;

  // 1. Resolver los catalogProductIds afectados por scope (unión, dedupe).
  //    GLOBAL → todos los del usuario (sobre-incluir; markPublicationsDrift
  //    reevalúa y solo marca drift real). PROVIDER/CATEGORY → por scopeId.
  const idSet = new Set<string>(extraCatalogProductIds);
  for (const ref of scopes) {
    let rows: { id: string }[] = [];
    if (ref.scope === "GLOBAL") {
      rows = await prisma.catalogProduct.findMany({
        where: { userId }, select: { id: true },
      });
    } else if (ref.scope === "PROVIDER" && ref.scopeId) {
      rows = await prisma.catalogProduct.findMany({
        where: { userId, providerId: ref.scopeId }, select: { id: true },
      });
    } else if (ref.scope === "CATEGORY" && ref.scopeId) {
      rows = await prisma.catalogProduct.findMany({
        where: { userId, assignedCategoryId: ref.scopeId }, select: { id: true },
      });
    }
    for (const r of rows) idSet.add(r.id);
  }
  const ids = [...idSet];

  // 2. Reusar markPublicationsDrift (lee reglas activas AHORA → debe llamarse
  //    después del write de la regla).
  const markedOutdated = ids.length > 0 ? await markPublicationsDrift(prisma, ids) : 0;

  // 3. EventLog de causa a nivel regla.
  await logInfo({
    source: "USER",
    type: "PRICING_RULE_CHANGED",
    title: `Regla de pricing ${ACTION_LABEL[action]} — ${ruleName}`,
    userId,
    metadata: {
      ruleId,
      action,
      scopes,
      affectedEvaluated: ids.length,
      markedOutdated,
      ...(params.marginPercentOld !== undefined ? { marginPercentOld: params.marginPercentOld } : {}),
      ...(params.marginPercentNew !== undefined ? { marginPercentNew: params.marginPercentNew } : {}),
    },
  });

  return { affectedEvaluated: ids.length, markedOutdated };
}
