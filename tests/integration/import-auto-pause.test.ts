// 1A.2-import — el path import auto-pausa productos removidos por proveedor con
// pausedBySystem=true (igual que el worker), para que B los reactive al reaparecer.
// Estrategia "encolar": NO pushea Woo dentro del import; deja pp PENDING_SYNC y el
// consistency-check / drainer lo baja a draft.
//
// Helper extraído (reconcileRemovedOnImport) para poder testear con prisma
// inyectado — el route handler usa el prisma de prod y no se testea directo.

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
import { reconcileRemovedOnImport } from "@/lib/catalog/reconcile-removed-on-import";
import { upsertCatalogProducts } from "@/lib/catalog/upsert-catalog-products";
import { runConsistencyCheck } from "../../worker/src/consistency-check";

function wooProduct(id: number, status = "draft") {
  return {
    id, sku: "T-1", name: "m", status, regular_price: "0.00", price: "0.00",
    stock_quantity: null, manage_stock: false, stock_status: "instock",
    permalink: "https://shop.example.test/?p=" + id, images: [], categories: [], description: "",
  };
}

describe("reconcileRemovedOnImport — auto-pausa honesta del import", () => {
  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await testPrisma.$disconnect(); });

  it("1. remueve SUPPLIER publicado → SUPPLIER_REMOVED + PAUSED + pausedBySystem=true + pp PENDING_SYNC", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id, { skuPrefix: "T-" });
    const { store } = await createTestStore(user.id);
    const cp = await createTestCatalogProduct(user.id, provider.id, {
      sku: "GONE-1", finalPrice: 1000, internalStatus: "PUBLISHED", sourceType: "IMPORTED",
    });
    await createTestPublication(cp.id, store.id, {
      status: "ACTIVE", syncStatus: "SYNCED", externalProductId: "7001",
    });

    const r = await reconcileRemovedOnImport(testPrisma, {
      userId: user.id, providerId: provider.id, importedSkus: ["OTHER"], importBatchId: "imp_test",
    });
    expect(r.removedPaused).toBe(1);

    const after = await testPrisma.catalogProduct.findUniqueOrThrow({ where: { id: cp.id } });
    expect(after.supplierStatus).toBe("SUPPLIER_REMOVED");
    expect(after.internalStatus).toBe("PAUSED");
    expect(after.pausedBySystem).toBe(true);

    const pp = await testPrisma.productPublication.findFirstOrThrow({ where: { catalogProductId: cp.id } });
    expect(pp.syncStatus).toBe("PENDING_SYNC");
    expect(pp.pendingSync).toBe(true);
    // Encolar: NO se pushea Woo en el import → pp.status sigue ACTIVE (lo baja el drainer).
    expect(pp.status).toBe("ACTIVE");
  });

  it("2. producto PAUSED manualmente (pausedBySystem=false) → NO se toca su estado; sólo supplierStatus", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id);
    const cp = await createTestCatalogProduct(user.id, provider.id, {
      sku: "MANUAL-PAUSE", internalStatus: "PAUSED", sourceType: "IMPORTED",
    });
    // pausedBySystem default = false (pausa manual).

    await reconcileRemovedOnImport(testPrisma, {
      userId: user.id, providerId: provider.id, importedSkus: ["OTHER"], importBatchId: "imp_test",
    });

    const after = await testPrisma.catalogProduct.findUniqueOrThrow({ where: { id: cp.id } });
    expect(after.supplierStatus).toBe("SUPPLIER_REMOVED"); // Caso 2: solo esto
    expect(after.internalStatus).toBe("PAUSED");           // intacto
    expect(after.pausedBySystem).toBe(false);              // pausa manual preservada
  });

  it("3. OWN/HYBRID → NO se auto-pausan; sólo supplierStatus=SUPPLIER_REMOVED", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id);
    const cpOwn = await createTestCatalogProduct(user.id, provider.id, {
      sku: "OWN-1", internalStatus: "PUBLISHED", sourceType: "IMPORTED",
    });
    await testPrisma.catalogProduct.update({ where: { id: cpOwn.id }, data: { stockSource: "OWN" } });

    await reconcileRemovedOnImport(testPrisma, {
      userId: user.id, providerId: provider.id, importedSkus: ["OTHER"], importBatchId: "imp_test",
    });

    const after = await testPrisma.catalogProduct.findUniqueOrThrow({ where: { id: cpOwn.id } });
    expect(after.supplierStatus).toBe("SUPPLIER_REMOVED");
    expect(after.internalStatus).toBe("PUBLISHED"); // NO pausado
    expect(after.pausedBySystem).toBe(false);
    expect(after.stockSource).toBe("OWN");          // intacto
  });

  it("4. cadena A→B: import auto-pausa (pausedBySystem=true) → proveedor reaparece → B reactiva a PUBLISHED", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id, { skuPrefix: "T-" });
    const { store } = await createTestStore(user.id);
    const cp = await createTestCatalogProduct(user.id, provider.id, {
      sku: "BACK-1", finalPrice: 1500, internalStatus: "PUBLISHED", sourceType: "SCRAPED",
    });
    await createTestPublication(cp.id, store.id, {
      sku: "T-BACK-1", status: "ACTIVE", syncStatus: "SYNCED", externalProductId: "7100",
    });

    // A: el import auto-pausa (setea pausedBySystem=true).
    await reconcileRemovedOnImport(testPrisma, {
      userId: user.id, providerId: provider.id, importedSkus: ["OTHER"], importBatchId: "imp_test",
    });
    const paused = await testPrisma.catalogProduct.findUniqueOrThrow({ where: { id: cp.id } });
    expect(paused.pausedBySystem).toBe(true);
    expect(paused.internalStatus).toBe("PAUSED");

    // B: el proveedor reaparece (extracción trae de nuevo el SKU) → reactiva.
    const job = await createTestExtractionJob(user.id, provider.id);
    await createTestExtractedProduct(job.id, provider.id, {
      sku: "BACK-1", name: "Volvió", wholesalePrice: 100,
    });
    const restoreStatic = mockWooFromIntegration();
    const restore = applyWooMock({
      updateProduct: async (id: number) => wooProduct(id, "publish"),
      createProduct: async () => wooProduct(7100, "publish"),
    });
    try {
      await upsertCatalogProducts(job.id, testPrisma);
    } finally { restore(); restoreStatic(); }

    const reactivated = await testPrisma.catalogProduct.findUniqueOrThrow({ where: { id: cp.id } });
    expect(reactivated.internalStatus).toBe("PUBLISHED");
    expect(reactivated.pausedBySystem).toBe(false);
  });

  it("5. el estado import-auto-pausado lo drena el consistency-check a draft", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id, { skuPrefix: "T-" });
    const { store } = await createTestStore(user.id);
    const cp = await createTestCatalogProduct(user.id, provider.id, {
      sku: "DRAIN-1", finalPrice: 1000, internalStatus: "PUBLISHED", sourceType: "IMPORTED",
    });
    await createTestPublication(cp.id, store.id, {
      sku: "T-DRAIN-1", status: "ACTIVE", syncStatus: "SYNCED", externalProductId: "7200",
    });

    await reconcileRemovedOnImport(testPrisma, {
      userId: user.id, providerId: provider.id, importedSkus: ["OTHER"], importBatchId: "imp_test",
    });
    // Pre-drenado: pp ACTIVE (el trigger de consistency-check Caso 2).
    const before = await testPrisma.productPublication.findFirstOrThrow({ where: { catalogProductId: cp.id } });
    expect(before.status).toBe("ACTIVE");

    const restoreStatic = mockWooFromIntegration();
    const restore = applyWooMock({ updateProductStatus: async (id: number) => wooProduct(id, "draft") });
    try {
      await runConsistencyCheck(testPrisma);
    } finally { restore(); restoreStatic(); }

    const after = await testPrisma.productPublication.findFirstOrThrow({ where: { catalogProductId: cp.id } });
    expect(after.status).toBe("PAUSED");
    expect(after.externalStatus).toBe("draft");
    expect(after.syncStatus).toBe("SYNCED");
  });
});
