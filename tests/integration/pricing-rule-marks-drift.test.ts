// D1 — detección de drift por cambio de regla de pricing.
// Cuando cambia una regla (crear/PATCH/DELETE), los productos publicados cuyo
// precio calculado quedó distinto al snapshot priceInStore deben marcarse
// OUTDATED + pendingSync (vía markPublicationsDrift), con EventLog
// PRICING_RULE_CHANGED. El helper markDriftForRuleChange encapsula
// "resolver ids por scope + markPublicationsDrift + EventLog" para ser testeable
// con prisma inyectado (los route handlers usan el prisma de prod).
//
// Los tests verifican el RESULTADO observable (pub OUTDATED), no solo que se llamó.

import "../setup/env";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, truncateAll } from "../setup/db";
import {
  createTestCatalogProduct,
  createTestProvider,
  createTestPublication,
  createTestStore,
  createTestUser,
} from "../helpers/factories";
import { markDriftForRuleChange } from "@/lib/catalog/mark-drift-for-rule-change";
import { markPublicationsDrift } from "@/lib/catalog/mark-publications-drift";

type Rounding = "NONE" | "CEIL" | "NEAREST_100" | "NEAREST_500" | "ENDING_990";

async function rule(
  userId: string,
  scope: "GLOBAL" | "PROVIDER" | "CATEGORY",
  scopeId: string | null,
  marginPercent: number,
  priority = 0
) {
  return testPrisma.pricingRule.create({
    data: {
      userId, name: `R-${scope}-${marginPercent}`, scope, scopeId,
      marginPercent, method: "MARKUP_ON_COST", roundingMode: "NONE" as Rounding,
      isActive: true, priority,
    },
  });
}

async function pubAt(cpId: string, storeId: string, priceInStore: number) {
  const pub = await createTestPublication(cpId, storeId, {
    status: "ACTIVE", syncStatus: "SYNCED", externalProductId: "9000",
  });
  await testPrisma.productPublication.update({
    where: { id: pub.id }, data: { priceInStore },
  });
  return pub;
}

const getPub = (cpId: string) =>
  testPrisma.productPublication.findFirstOrThrow({ where: { catalogProductId: cpId } });

describe("markDriftForRuleChange — D1", () => {
  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await testPrisma.$disconnect(); });

  it("1. PROVIDER cambia margen → publicado con drift real → OUTDATED + pendingSync + EventLog", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id);
    const { store } = await createTestStore(user.id);
    const r = await rule(user.id, "PROVIDER", provider.id, 27);
    const cp = await createTestCatalogProduct(user.id, provider.id, { sku: "P1", wholesalePrice: 100, internalStatus: "PUBLISHED" });
    await pubAt(cp.id, store.id, 127); // synced con margen 27 (100*1.27)

    await testPrisma.pricingRule.update({ where: { id: r.id }, data: { marginPercent: 50 } });
    const res = await markDriftForRuleChange(testPrisma, {
      userId: user.id, ruleId: r.id, action: "updated",
      scopes: [{ scope: "PROVIDER", scopeId: provider.id }],
      ruleName: r.name, marginPercentOld: 27, marginPercentNew: 50,
    });

    expect(res.markedOutdated).toBe(1);
    const pub = await getPub(cp.id);
    expect(pub.syncStatus).toBe("OUTDATED");
    expect(pub.pendingSync).toBe(true);

    const ev = await testPrisma.eventLog.findFirst({ where: { type: "PRICING_RULE_CHANGED" } });
    expect(ev).not.toBeNull();
    expect((ev!.metadata as Record<string, unknown>).markedOutdated).toBe(1);
  });

  it("2. no-op (mismo margen) → no marca nada", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id);
    const { store } = await createTestStore(user.id);
    const r = await rule(user.id, "PROVIDER", provider.id, 27);
    const cp = await createTestCatalogProduct(user.id, provider.id, { sku: "P2", wholesalePrice: 100, internalStatus: "PUBLISHED" });
    await pubAt(cp.id, store.id, 127);

    const res = await markDriftForRuleChange(testPrisma, {
      userId: user.id, ruleId: r.id, action: "updated",
      scopes: [{ scope: "PROVIDER", scopeId: provider.id }],
      ruleName: r.name, marginPercentOld: 27, marginPercentNew: 27,
    });

    expect(res.markedOutdated).toBe(0);
    const pub = await getPub(cp.id);
    expect(pub.syncStatus).toBe("SYNCED");
    expect(pub.pendingSync).toBe(false);
  });

  it("3. producto NO publicado (sin pp ACTIVE) → no se toca", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id);
    await createTestStore(user.id);
    const r = await rule(user.id, "PROVIDER", provider.id, 27);
    await createTestCatalogProduct(user.id, provider.id, { sku: "P3", wholesalePrice: 100, internalStatus: "NOT_PUBLISHED" });
    // sin publication

    await testPrisma.pricingRule.update({ where: { id: r.id }, data: { marginPercent: 99 } });
    const res = await markDriftForRuleChange(testPrisma, {
      userId: user.id, ruleId: r.id, action: "updated",
      scopes: [{ scope: "PROVIDER", scopeId: provider.id }],
      ruleName: r.name, marginPercentOld: 27, marginPercentNew: 99,
    });
    expect(res.markedOutdated).toBe(0);
  });

  it("4. override manualMargin → NO se marca (la regla no lo afecta, no hay drift real)", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id);
    const { store } = await createTestStore(user.id);
    const r = await rule(user.id, "PROVIDER", provider.id, 27);
    const cp = await createTestCatalogProduct(user.id, provider.id, { sku: "P4", wholesalePrice: 100, manualMargin: 20, internalStatus: "PUBLISHED" });
    await pubAt(cp.id, store.id, 120); // manual 20% gana: 100*1.20

    await testPrisma.pricingRule.update({ where: { id: r.id }, data: { marginPercent: 50 } });
    const res = await markDriftForRuleChange(testPrisma, {
      userId: user.id, ruleId: r.id, action: "updated",
      scopes: [{ scope: "PROVIDER", scopeId: provider.id }],
      ruleName: r.name, marginPercentOld: 27, marginPercentNew: 50,
    });

    expect(res.markedOutdated).toBe(0);
    const pub = await getPub(cp.id);
    expect(pub.syncStatus).toBe("SYNCED");
  });

  it("5. RETARGET PROVIDER A→B → driftan AMBOS lados (A pierde la regla, B la gana)", async () => {
    const user = await createTestUser();
    const provA = await createTestProvider(user.id);
    const provB = await createTestProvider(user.id);
    const { store } = await createTestStore(user.id);
    // baseline global 10% para que ambos lados tengan precio calculable.
    await rule(user.id, "GLOBAL", null, 10);
    const r = await rule(user.id, "PROVIDER", provA.id, 27, 1); // gana sobre global

    const cpA = await createTestCatalogProduct(user.id, provA.id, { sku: "A1", wholesalePrice: 100, internalStatus: "PUBLISHED" });
    await pubAt(cpA.id, store.id, 127); // synced con R en A (27%)
    const cpB = await createTestCatalogProduct(user.id, provB.id, { sku: "B1", wholesalePrice: 100, internalStatus: "PUBLISHED" });
    await pubAt(cpB.id, store.id, 110); // synced con global (10%)

    // retarget: R pasa de provA a provB
    await testPrisma.pricingRule.update({ where: { id: r.id }, data: { scopeId: provB.id } });
    const res = await markDriftForRuleChange(testPrisma, {
      userId: user.id, ruleId: r.id, action: "updated",
      scopes: [
        { scope: "PROVIDER", scopeId: provA.id }, // viejo
        { scope: "PROVIDER", scopeId: provB.id }, // nuevo
      ],
      ruleName: r.name,
    });

    expect(res.markedOutdated).toBe(2);
    const pubA = await getPub(cpA.id);
    const pubB = await getPub(cpB.id);
    expect(pubA.syncStatus).toBe("OUTDATED"); // A: 127 → 110 (cae a global)
    expect(pubB.syncStatus).toBe("OUTDATED"); // B: 110 → 127 (gana R)
  });

  it("6. DELETE → orden correcto (capturar ids con regla viva → delete → marcar con regla muerta) → OUTDATED", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id);
    const { store } = await createTestStore(user.id);
    const r = await rule(user.id, "PROVIDER", provider.id, 27);
    const cp = await createTestCatalogProduct(user.id, provider.id, { sku: "D1", wholesalePrice: 100, internalStatus: "PUBLISHED" });
    await testPrisma.catalogProduct.update({ where: { id: cp.id }, data: { pricingRuleId: r.id } });
    await pubAt(cp.id, store.id, 127); // synced con R (27%)

    // Simula el handler DELETE: capturar linked ids con la regla VIVA.
    const linked = await testPrisma.catalogProduct.findMany({ where: { pricingRuleId: r.id }, select: { id: true } });
    const linkedIds = linked.map((x) => x.id);
    expect(linkedIds).toContain(cp.id);
    // commitear el delete (desvincula + borra).
    await testPrisma.$transaction([
      testPrisma.catalogProduct.updateMany({ where: { pricingRuleId: r.id }, data: { pricingRuleId: null } }),
      testPrisma.pricingRule.delete({ where: { id: r.id } }),
    ]);
    // marcar drift con la regla YA muerta → resolvePricing no encuentra regla →
    // precio null → drift → OUTDATED. (Si se marcara ANTES del delete, 127=127 → no drift.)
    const res = await markDriftForRuleChange(testPrisma, {
      userId: user.id, ruleId: r.id, action: "deleted",
      scopes: [{ scope: "PROVIDER", scopeId: provider.id }],
      extraCatalogProductIds: linkedIds,
      ruleName: r.name, marginPercentOld: 27,
    });

    expect(res.affectedEvaluated).toBeGreaterThanOrEqual(1);
    expect(res.markedOutdated).toBe(1);
    const pub = await getPub(cp.id);
    expect(pub.syncStatus).toBe("OUTDATED");
    expect(pub.pendingSync).toBe(true);
  });

  // Medición D1: markPublicationsDrift sobre ~900 publicaciones ≈ 2754ms.
  // Si el volumen crece bastante, D2/batching sube de prioridad.
  it("7. GLOBAL worst-case: mide el tiempo de markPublicationsDrift sobre ~900 publicados", async () => {
    const N = 900;
    const user = await createTestUser();
    const provider = await createTestProvider(user.id);
    const { store } = await createTestStore(user.id);
    await rule(user.id, "GLOBAL", null, 30); // precio = 100*1.30 = 130

    await testPrisma.catalogProduct.createMany({
      data: Array.from({ length: N }, (_, i) => ({
        userId: user.id, providerId: provider.id, sku: `G${i}`,
        supplierName: "x", internalStatus: "PUBLISHED" as const,
        sourceType: "SCRAPED" as const, wholesalePrice: 100, lastSeenAt: new Date(),
      })),
    });
    const cps = await testPrisma.catalogProduct.findMany({ where: { userId: user.id }, select: { id: true } });
    await testPrisma.productPublication.createMany({
      data: cps.map((c) => ({
        catalogProductId: c.id, storeId: store.id, status: "ACTIVE" as const,
        syncStatus: "SYNCED" as const, pendingSync: false, priceInStore: 100, // drift vs 130
      })),
    });
    const ids = cps.map((c) => c.id);

    const t0 = Date.now();
    const marked = await markPublicationsDrift(testPrisma, ids);
    const ms = Date.now() - t0;
    console.log(`[D1 timing] markPublicationsDrift sobre ${ids.length} publicados: ${ms}ms, marcados=${marked}`);

    expect(marked).toBe(N);
    expect(ms).toBeLessThan(30000); // tope generoso; el número real va al log
  }, 60000);
});
