// B-Prep-1 — clasificación de errores de PUSH + invariante del drainer.
//   publishProductToWoo ante fallo de Woo debe clasificar vía el helper compartido:
//     recoverable/ambiguous → PENDING_SYNC + pendingSync=true
//     terminal/unknown      → ERROR_TERMINAL + pendingSync=false
//   y NUNCA escribir pp.status (eje operativo) — AC2.
//   ERROR_TERMINAL sale de la cola del drainer POR VALOR (no está en su OR).

import "../setup/env";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { PublicationSyncStatus } from "@prisma/client";
import { testPrisma, truncateAll } from "../setup/db";
import { applyWooMock } from "../helpers/woo-mock";
import {
  createTestCatalogProduct,
  createTestProvider,
  createTestPublication,
  createTestStore,
  createTestUser,
} from "../helpers/factories";
import { WooCommerceClient } from "@/lib/integrations/woocommerce/client";
import { WooApiError } from "@/lib/integrations/woocommerce/woo-api-error";
import { publishProductToWoo } from "@/lib/integrations/woocommerce/publication-service";

async function arrange() {
  const user = await createTestUser();
  const provider = await createTestProvider(user.id, { skuPrefix: "T-" });
  const { store } = await createTestStore(user.id);
  const cp = await createTestCatalogProduct(user.id, provider.id, {
    sku: "P-1", finalPrice: 1000, internalStatus: "PUBLISHED",
  });
  // sku == externalSku → sin drift → guard 3 no aplica; igual mockeamos
  // findProductsBySku=[] por las dudas.
  await createTestPublication(cp.id, store.id, {
    sku: "T-P-1", externalSku: "T-P-1", status: "ACTIVE", syncStatus: "SYNCED", externalProductId: "5001",
  });
  return { store, cp };
}

describe("publishProductToWoo — clasificación de fallo de push (B-Prep-1)", () => {
  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await testPrisma.$disconnect(); });

  const cases = [
    { name: "terminal (400)", err: () => new WooApiError({ message: "x", kind: "http", status: 400, op: "update" }), syncStatus: "ERROR_TERMINAL", pendingSync: false },
    { name: "transitorio (503)", err: () => new WooApiError({ message: "x", kind: "http", status: 503, op: "update" }), syncStatus: "PENDING_SYNC", pendingSync: true },
  ];

  for (const c of cases) {
    it(`push falla ${c.name} → syncStatus=${c.syncStatus}, pendingSync=${c.pendingSync}, sin pp.status=ERROR`, async () => {
      const { store, cp } = await arrange();
      const client = new WooCommerceClient("https://shop.example.test", "k", "s");
      const restore = applyWooMock({
        findProductsBySku: async () => [],
        updateProduct: async () => { throw c.err(); },
      });
      try {
        const res = await publishProductToWoo(testPrisma, client, store.id, cp.id, []);
        expect(res.success).toBe(false);
      } finally { restore(); }
      const pp = await testPrisma.productPublication.findFirstOrThrow({ where: { catalogProductId: cp.id } });
      expect(pp.syncStatus).toBe(c.syncStatus);
      expect(pp.pendingSync).toBe(c.pendingSync);
      // AC2: el fallo de sync NO escribe el eje operativo.
      expect(pp.status).not.toBe("ERROR");
    });
  }
});

describe("Invariante del drainer — ERROR_TERMINAL sale POR VALOR (B-Prep-1)", () => {
  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await testPrisma.$disconnect(); });

  it("el predicado del drainer NO selecciona ERROR_TERMINAL (sí ERROR/PENDING_SYNC/OUTDATED)", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id);
    const { store } = await createTestStore(user.id);

    async function seed(sku: string, syncStatus: PublicationSyncStatus) {
      const cp = await createTestCatalogProduct(user.id, provider.id, { sku });
      const p = await createTestPublication(cp.id, store.id, {
        status: "ACTIVE", externalProductId: "9", pendingSync: false,
      });
      await testPrisma.productPublication.update({ where: { id: p.id }, data: { syncStatus } });
    }
    await seed("ET", "ERROR_TERMINAL");
    await seed("E", "ERROR");
    await seed("PS", "PENDING_SYNC");
    await seed("OD", "OUTDATED");
    await seed("OK", "SYNCED");

    // Réplica EXACTA del OR del drainer (sync/publications/route.ts:112-119).
    // El brazo PAUSED∧publish no aplica acá (ninguna fila lo cumple).
    const selected = await testPrisma.productPublication.findMany({
      where: {
        storeId: store.id,
        OR: [
          { pendingSync: true },
          { syncStatus: "PENDING_SYNC" },
          { syncStatus: "OUTDATED" },
          { syncStatus: "ERROR" },
          { AND: [{ status: "PAUSED" }, { externalStatus: "publish" }] },
        ],
      },
      select: { syncStatus: true },
    });
    const got = new Set(selected.map((p) => p.syncStatus));
    expect(got.has("ERROR_TERMINAL")).toBe(false); // ← el corazón del diseño
    expect(got.has("ERROR")).toBe(true);
    expect(got.has("PENDING_SYNC")).toBe(true);
    expect(got.has("OUTDATED")).toBe(true);
    expect(got.has("SYNCED")).toBe(false);
  });
});
