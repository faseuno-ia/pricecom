// Flujo de upsertCatalogProducts (worker post-extracción): detecta productos
// que desaparecieron del proveedor y auto-pausa; detecta los que reaparecieron
// y reactiva (o solo notifica si la pausa fue manual). Casos:
//
//   1. AUTO-PAUSE con pp publicada en Woo  → cp PAUSED + pp PAUSED + pausa en Woo
//   2. AUTO-PAUSE sin Woo                  → cp PAUSED + sin tocar Woo
//   3. REACTIVATION automática             → cp PUBLISHED + push update a Woo
//   4. PAUSA MANUAL respetada              → cp permanece PAUSED + solo log informativo
//
// Igual molde que lazy-sku: factories + applyWooMock + función REAL +
// assert sobre DB + sobre llamadas al mock. fileParallelism=false en el
// config previene interferencia entre archivos.

import "../setup/env";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, truncateAll } from "../setup/db";
import { applyWooMock, mockWooFromIntegration } from "../helpers/woo-mock";
import {
  createTestCatalogProduct,
  createTestExtractedProduct,
  createTestExtractionJob,
  createTestProvider,
  createTestPublication,
  createTestStore,
  createTestUser,
} from "../helpers/factories";
import { upsertCatalogProducts } from "@/lib/catalog/upsert-catalog-products";

function mockWooProduct(id: number, sku: string, status = "publish") {
  return {
    id,
    sku,
    name: "Mocked product",
    status,
    regular_price: "0.00",
    price: "0.00",
    stock_quantity: null,
    manage_stock: false,
    stock_status: "instock",
    permalink: `https://shop.example.test/?p=${id}`,
    images: [],
    categories: [],
    description: "",
  };
}

describe("upsertCatalogProducts — auto-pause + reactivación", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it("1. AUTO-PAUSE con Woo: producto publicado que desaparece se pausa local y en Woo", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id, { skuPrefix: "T-" });
    const { store } = await createTestStore(user.id);
    const cp = await createTestCatalogProduct(user.id, provider.id, {
      sku: "GONE-1",
      finalPrice: 1500,
      internalStatus: "PUBLISHED",
    });
    await createTestPublication(cp.id, store.id, {
      sku: "T-GONE-1",
      status: "ACTIVE",
      syncStatus: "SYNCED",
      externalProductId: "55001",
    });

    const job = await createTestExtractionJob(user.id, provider.id);
    // En este job vino OTRO producto, NO GONE-1 → cp desaparece.
    await createTestExtractedProduct(job.id, provider.id, {
      sku: "ALIVE-1",
      name: "Otro producto que sí vino",
      wholesalePrice: 100,
    });

    const updateCalls: Array<{ id: number; data: { status?: string } }> = [];
    const restoreProto = applyWooMock({
      updateProduct: async (id: number, data: { status?: string }) => {
        updateCalls.push({ id, data });
        return mockWooProduct(id, "T-GONE-1", data.status ?? "draft");
      },
    });
    const restoreStatic = mockWooFromIntegration();

    try {
      await upsertCatalogProducts(job.id, testPrisma);
    } finally {
      restoreProto();
      restoreStatic();
    }

    const cpAfter = await testPrisma.catalogProduct.findUnique({
      where: { id: cp.id },
    });
    expect(cpAfter?.supplierStatus).toBe("SUPPLIER_REMOVED");
    expect(cpAfter?.internalStatus).toBe("PAUSED");
    expect(cpAfter?.pausedBySystem).toBe(true);

    const pubAfter = await testPrisma.productPublication.findUnique({
      where: {
        catalogProductId_storeId: { catalogProductId: cp.id, storeId: store.id },
      },
    });
    expect(pubAfter?.status).toBe("PAUSED");
    expect(pubAfter?.externalStatus).toBe("draft");
    expect(pubAfter?.pendingSync).toBe(false);

    // El mock recibió la llamada con el wooId correcto y status=draft.
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].id).toBe(55001);
    expect(updateCalls[0].data.status).toBe("draft");

    // EventLogs: PRODUCT_AUTO_PAUSED + WOO_PRODUCT_PAUSED.
    const events = await testPrisma.eventLog.findMany({
      where: { productId: cp.id },
      select: { type: true },
    });
    const types = events.map((e) => e.type);
    expect(types).toContain("PRODUCT_AUTO_PAUSED");
    expect(types).toContain("WOO_PRODUCT_PAUSED");
  });

  it("2. AUTO-PAUSE sin Woo: producto publicado sin pp en Woo se pausa local, no toca Woo", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id, { skuPrefix: "T-" });
    // Store existe pero el cp no tiene publication (caso real: cp marcado
    // PUBLISHED por el flow pero la pub nunca llegó a sincronizar a Woo).
    await createTestStore(user.id);
    const cp = await createTestCatalogProduct(user.id, provider.id, {
      sku: "GONE-2",
      finalPrice: 1500,
      internalStatus: "PUBLISHED",
    });

    const job = await createTestExtractionJob(user.id, provider.id);
    await createTestExtractedProduct(job.id, provider.id, {
      sku: "OTHER-1",
      name: "Otro distinto",
    });

    let updateCalled = false;
    let findCalled = false;
    const restoreProto = applyWooMock({
      updateProduct: async () => {
        updateCalled = true;
        return mockWooProduct(0, "");
      },
      findProductsBySku: async () => {
        findCalled = true;
        return [];
      },
    });
    const restoreStatic = mockWooFromIntegration();

    try {
      await upsertCatalogProducts(job.id, testPrisma);
    } finally {
      restoreProto();
      restoreStatic();
    }

    const cpAfter = await testPrisma.catalogProduct.findUnique({
      where: { id: cp.id },
    });
    expect(cpAfter?.supplierStatus).toBe("SUPPLIER_REMOVED");
    expect(cpAfter?.internalStatus).toBe("PAUSED");
    expect(cpAfter?.pausedBySystem).toBe(true);

    // Ningún método de Woo se invocó: no había pub con externalProductId.
    expect(updateCalled).toBe(false);
    expect(findCalled).toBe(false);

    const events = await testPrisma.eventLog.findMany({
      where: { productId: cp.id, type: "PRODUCT_AUTO_PAUSED" },
    });
    expect(events).toHaveLength(1);
  });

  it("3. REACTIVACIÓN automática: producto SUPPLIER_REMOVED + pausedBySystem que reaparece se reactiva y empuja a Woo", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id, { skuPrefix: "T-" });
    const { store } = await createTestStore(user.id);
    const cp = await createTestCatalogProduct(user.id, provider.id, {
      sku: "BACK-1",
      finalPrice: 2000,
      internalStatus: "PAUSED",
    });
    // pp con externalProductId (estaba publicado, después auto-pausado por
    // el worker en una corrida anterior).
    await createTestPublication(cp.id, store.id, {
      sku: "T-BACK-1",
      externalSku: "T-BACK-1",
      status: "PAUSED",
      syncStatus: "SYNCED",
      externalProductId: "55003",
    });
    // Setear el estado "SUPPLIER_REMOVED + pausedBySystem=true" — la
    // factory no expone esos campos, los seteo directamente.
    await testPrisma.catalogProduct.update({
      where: { id: cp.id },
      data: { supplierStatus: "SUPPLIER_REMOVED", pausedBySystem: true },
    });

    const job = await createTestExtractionJob(user.id, provider.id);
    // Esta vez el sku BACK-1 SÍ viene en la extracción.
    await createTestExtractedProduct(job.id, provider.id, {
      sku: "BACK-1",
      name: "Producto que volvió",
      wholesalePrice: 100,
    });

    const updateCalls: Array<{ id: number; data: Record<string, unknown> }> = [];
    const restoreProto = applyWooMock({
      updateProduct: async (id: number, data: Record<string, unknown>) => {
        updateCalls.push({ id, data });
        return mockWooProduct(id, "T-BACK-1", "publish");
      },
      // Guard 3 puede llamar si hay drift de SKU; en este caso pp.sku ===
      // externalSku, así que no se llama. Lo mockeamos por las dudas.
      findProductsBySku: async () => [],
    });
    const restoreStatic = mockWooFromIntegration();

    try {
      await upsertCatalogProducts(job.id, testPrisma);
    } finally {
      restoreProto();
      restoreStatic();
    }

    const cpAfter = await testPrisma.catalogProduct.findUnique({
      where: { id: cp.id },
    });
    expect(cpAfter?.supplierStatus).toBe("ACTIVE");
    expect(cpAfter?.internalStatus).toBe("PUBLISHED");
    expect(cpAfter?.pausedBySystem).toBe(false);

    const pubAfter = await testPrisma.productPublication.findUnique({
      where: {
        catalogProductId_storeId: { catalogProductId: cp.id, storeId: store.id },
      },
    });
    expect(pubAfter?.status).toBe("ACTIVE");
    expect(pubAfter?.syncStatus).toBe("SYNCED");

    // updateProduct se llamó (publishProductToWoo path UPDATE, pp ya tenía wooId).
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0].id).toBe(55003);
    expect(updateCalls[0].data.status).toBe("publish");

    // EventLog: PRODUCT_REACTIVATED + WOO_SYNC_SUCCESS (de publishProductToWoo).
    const events = await testPrisma.eventLog.findMany({
      where: { productId: cp.id },
      select: { type: true },
    });
    const types = events.map((e) => e.type);
    expect(types).toContain("PRODUCT_REACTIVATED");
    expect(types).toContain("WOO_SYNC_SUCCESS");
  });

  it("4. PAUSA MANUAL respetada: cp PAUSED + pausedBySystem=false que reaparece NO se reactiva solo", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id, { skuPrefix: "T-" });
    const { store } = await createTestStore(user.id);
    const cp = await createTestCatalogProduct(user.id, provider.id, {
      sku: "MANUAL-PAUSE",
      finalPrice: 2000,
      internalStatus: "PAUSED",
    });
    await createTestPublication(cp.id, store.id, {
      sku: "T-MANUAL-PAUSE",
      externalSku: "T-MANUAL-PAUSE",
      status: "PAUSED",
      externalProductId: "55004",
    });
    // SUPPLIER_REMOVED + pausa MANUAL (pausedBySystem=false, default de la
    // factory, pero lo seteo explícito para que sea obvio en el test).
    await testPrisma.catalogProduct.update({
      where: { id: cp.id },
      data: { supplierStatus: "SUPPLIER_REMOVED", pausedBySystem: false },
    });

    const job = await createTestExtractionJob(user.id, provider.id);
    await createTestExtractedProduct(job.id, provider.id, {
      sku: "MANUAL-PAUSE",
      name: "Producto pausado manualmente",
      wholesalePrice: 100,
    });

    let updateCalled = false;
    const restoreProto = applyWooMock({
      updateProduct: async () => {
        updateCalled = true;
        return mockWooProduct(0, "");
      },
      findProductsBySku: async () => [],
    });
    const restoreStatic = mockWooFromIntegration();

    try {
      await upsertCatalogProducts(job.id, testPrisma);
    } finally {
      restoreProto();
      restoreStatic();
    }

    const cpAfter = await testPrisma.catalogProduct.findUnique({
      where: { id: cp.id },
    });
    // supplierStatus vuelve a ACTIVE porque sí está en la extracción ahora.
    expect(cpAfter?.supplierStatus).toBe("ACTIVE");
    // PERO internalStatus sigue PAUSED — el sistema respeta la decisión del usuario.
    expect(cpAfter?.internalStatus).toBe("PAUSED");
    expect(cpAfter?.pausedBySystem).toBe(false);

    const pubAfter = await testPrisma.productPublication.findUnique({
      where: {
        catalogProductId_storeId: { catalogProductId: cp.id, storeId: store.id },
      },
    });
    expect(pubAfter?.status).toBe("PAUSED"); // sin cambios

    // No se invocó Woo: el sistema no debe reactivar lo que el usuario pausó.
    expect(updateCalled).toBe(false);

    // EventLog: PRODUCT_REAPPEARED (informativo), NO PRODUCT_REACTIVATED.
    const events = await testPrisma.eventLog.findMany({
      where: { productId: cp.id },
      select: { type: true },
    });
    const types = events.map((e) => e.type);
    expect(types).toContain("PRODUCT_REAPPEARED");
    expect(types).not.toContain("PRODUCT_REACTIVATED");
  });
});
