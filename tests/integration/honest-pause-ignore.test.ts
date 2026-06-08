// 1A.2-ab — pause/ignore honestos. pauseProductInWoo ante fallo de Woo debe
// clasificar (classifyWooError) en vez de marcar todo ERROR+pendingSync=true:
//   recoverable / ambiguous / parse → PENDING_SYNC + pendingSync=true
//   terminal / unknown             → ERROR + pendingSync=false
// y NUNCA escribir pp.status="ERROR" (eso es eje operativo).
//
// Además: el helper pausePublicationsForCatalogProducts marca PENDING_SYNC
// cuando no hay credenciales (antes: continue silencioso → ACTIVE invisible).

import "../setup/env";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, truncateAll } from "../setup/db";
import { applyWooMock, mockWooFromIntegration } from "../helpers/woo-mock";
import {
  createTestCatalogProduct,
  createTestProvider,
  createTestPublication,
  createTestStore,
  createTestUser,
} from "../helpers/factories";
import { WooCommerceClient } from "@/lib/integrations/woocommerce/client";
import { WooApiError } from "@/lib/integrations/woocommerce/woo-api-error";
import { pauseProductInWoo } from "@/lib/integrations/woocommerce/publication-service";
import { pausePublicationsForCatalogProducts } from "@/lib/integrations/woocommerce/pause-publications";

function wooProduct(id: number, status = "draft") {
  return {
    id, sku: "T-1", name: "m", status, regular_price: "0.00", price: "0.00",
    stock_quantity: null, manage_stock: false, stock_status: "instock",
    permalink: "https://shop.example.test/?p=" + id, images: [], categories: [], description: "",
  };
}

async function arrange() {
  const user = await createTestUser();
  const provider = await createTestProvider(user.id, { skuPrefix: "T-" });
  const { store } = await createTestStore(user.id);
  const cp = await createTestCatalogProduct(user.id, provider.id, {
    sku: "P-1", finalPrice: 1000, internalStatus: "PUBLISHED",
  });
  const pp = await createTestPublication(cp.id, store.id, {
    sku: "T-P-1", status: "ACTIVE", syncStatus: "SYNCED", externalProductId: "5001",
  });
  return { user, store, cp, pp };
}

describe("pauseProductInWoo — clasificación honesta de fallo Woo", () => {
  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await testPrisma.$disconnect(); });

  it("Woo OK → SYNCED + pendingSync=false + pp.status=PAUSED", async () => {
    const { store, cp } = await arrange();
    const client = new WooCommerceClient("https://shop.example.test", "k", "s");
    const restore = applyWooMock({ updateProductStatus: async (id: number) => wooProduct(id) });
    try {
      const res = await pauseProductInWoo(testPrisma, client, store.id, cp.id);
      expect(res.success).toBe(true);
    } finally { restore(); }
    const pp = await testPrisma.productPublication.findFirstOrThrow({ where: { catalogProductId: cp.id } });
    expect(pp.syncStatus).toBe("SYNCED");
    expect(pp.pendingSync).toBe(false);
    expect(pp.status).toBe("PAUSED");
  });

  const cases: Array<{ name: string; err: () => unknown; syncStatus: string; pendingSync: boolean }> = [
    { name: "recoverable (503)", err: () => new WooApiError({ message: "x", kind: "http", status: 503, op: "status" }), syncStatus: "PENDING_SYNC", pendingSync: true },
    { name: "ambiguous (404)", err: () => new WooApiError({ message: "x", kind: "http", status: 404, op: "status" }), syncStatus: "PENDING_SYNC", pendingSync: true },
    { name: "parse", err: () => WooApiError.fromTransport(new SyntaxError("bad"), "status"), syncStatus: "PENDING_SYNC", pendingSync: true },
    { name: "terminal (400)", err: () => new WooApiError({ message: "x", kind: "http", status: 400, op: "status" }), syncStatus: "ERROR", pendingSync: false },
    { name: "unknown", err: () => WooApiError.fromTransport(new Error("???"), "status"), syncStatus: "ERROR", pendingSync: false },
  ];

  for (const c of cases) {
    it(`Woo falla ${c.name} → syncStatus=${c.syncStatus}, pendingSync=${c.pendingSync}, sin pp.status=ERROR`, async () => {
      const { store, cp } = await arrange();
      const client = new WooCommerceClient("https://shop.example.test", "k", "s");
      const restore = applyWooMock({ updateProductStatus: async () => { throw c.err(); } });
      try {
        const res = await pauseProductInWoo(testPrisma, client, store.id, cp.id);
        expect(res.success).toBe(false);
      } finally { restore(); }
      const pp = await testPrisma.productPublication.findFirstOrThrow({ where: { catalogProductId: cp.id } });
      expect(pp.syncStatus).toBe(c.syncStatus);
      expect(pp.pendingSync).toBe(c.pendingSync);
      // El fallo de sync NO debe escribir el eje operativo:
      expect(pp.status).not.toBe("ERROR");
    });
  }
});

describe("pausePublicationsForCatalogProducts — agujero sin credenciales", () => {
  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await testPrisma.$disconnect(); });

  it("sin integración/credenciales → pp PENDING_SYNC + pendingSync=true (visible, NO ACTIVE invisible)", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id);
    // Store SIN integración (sin credenciales).
    const store = await testPrisma.store.create({
      data: { userId: user.id, name: "NoCreds", platform: "WOOCOMMERCE", url: "https://x.test" },
    });
    const cp = await createTestCatalogProduct(user.id, provider.id, { sku: "NC-1", internalStatus: "PAUSED" });
    await createTestPublication(cp.id, store.id, {
      status: "ACTIVE", syncStatus: "SYNCED", externalProductId: "6001",
    });

    const result = await pausePublicationsForCatalogProducts(testPrisma, user.id, [cp.id]);
    expect(result.pendingNoClient).toBe(1);
    expect(result.pushed).toBe(0);

    const pp = await testPrisma.productPublication.findFirstOrThrow({ where: { catalogProductId: cp.id } });
    expect(pp.syncStatus).toBe("PENDING_SYNC");
    expect(pp.pendingSync).toBe(true);
    expect(pp.status).not.toBe("ERROR");
  });

  it("con credenciales + Woo OK → push, pp PAUSED/SYNCED", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id, { skuPrefix: "T-" });
    const { store } = await createTestStore(user.id);
    const cp = await createTestCatalogProduct(user.id, provider.id, { sku: "OK-1", internalStatus: "PAUSED" });
    await createTestPublication(cp.id, store.id, {
      status: "ACTIVE", syncStatus: "SYNCED", externalProductId: "6002",
    });
    const restoreStatic = mockWooFromIntegration();
    const restore = applyWooMock({ updateProductStatus: async (id: number) => wooProduct(id) });
    let result;
    try {
      result = await pausePublicationsForCatalogProducts(testPrisma, user.id, [cp.id]);
    } finally { restore(); restoreStatic(); }
    expect(result.pushed).toBe(1);
    expect(result.pendingNoClient).toBe(0);
    const pp = await testPrisma.productPublication.findFirstOrThrow({ where: { catalogProductId: cp.id } });
    expect(pp.status).toBe("PAUSED");
    expect(pp.syncStatus).toBe("SYNCED");
  });
});
