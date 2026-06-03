// Bug en upsertCatalogProducts: cuando una extracción cambia el wholesalePrice
// de un producto YA publicado, el cp se actualiza pero la pp NO queda marcada
// como pendingSync/OUTDATED. Consecuencia: el botón "Sincronizar pendientes"
// no la encuentra y el precio nuevo nunca llega a Woo.
//
// Estos 3 tests prueban el comportamiento esperado del FIX:
//   1. Cambio real de wholesale → pp queda marcada como OUTDATED + pendingSync.
//      ESTE TEST FALLA contra el código actual (RED → demuestra el bug).
//   2. Re-extracción con MISMO wholesale → pp NO se marca (no genera ruido).
//   3. Producto NUEVO (no había cp) → no se marca nada (no hay pp para marcar).
//
// Casos 2 y 3 son no-regresión: en el código actual ya pasan, pero verifican
// que el fix no se vuelva un "marca todo a ciegas".

import "../setup/env";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, truncateAll } from "../setup/db";
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

describe("upsertCatalogProducts — drift de precio post-extracción", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it("1. CAMBIO DE WHOLESALE: cp con pp ACTIVE → cambia wholesale en la extracción → pp queda marcada OUTDATED + pendingSync", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id, { skuPrefix: "T-" });
    await createTestStore(user.id);

    // Pricing rule activa por PROVIDER: +27% CEIL (mismo patrón que BAZAR 380
    // en el caso real). Sin esto, resolvePricing no puede calcular y
    // markPublicationsDrift cae a "drift defensivo" (false positive).
    await testPrisma.pricingRule.create({
      data: {
        userId: user.id,
        name: "Margen Test",
        scope: "PROVIDER",
        scopeId: provider.id,
        marginPercent: 27,
        method: "MARKUP_ON_COST",
        roundingMode: "CEIL",
        isActive: true,
        priority: 0,
      },
    });

    // cp publicado con wholesale=100 (precio viejo del proveedor).
    // Precio esperado HOY con wholesale=100: ceil(100 * 1.27) = 127.
    const cp = await createTestCatalogProduct(user.id, provider.id, {
      sku: "DRIFT-001",
      wholesalePrice: 100,
      internalStatus: "PUBLISHED",
    });

    const { store: anotherStore } = await createTestStore(user.id, { name: "B" });
    // pp ACTIVE en la primera store creada arriba. Para encontrarla
    // re-buscamos; createTestStore acaba de crear otra distinta para el cp.
    const stores = await testPrisma.store.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
    const primaryStore = stores[0]; // la primera (no la segunda que es para test isolation)
    void anotherStore; // marcador para typing

    // Snapshot Woo: pp.priceInStore = 127 (= cp.wholesalePrice viejo × 1.27 CEIL).
    // Eso es lo que Woo "vio" la última vez que se sincronizó.
    await createTestPublication(cp.id, primaryStore.id, {
      sku: "T-DRIFT-001",
      externalSku: "T-DRIFT-001",
      externalProductId: "55555",
      status: "ACTIVE",
      syncStatus: "SYNCED",
      pendingSync: false,
    });
    await testPrisma.productPublication.updateMany({
      where: { catalogProductId: cp.id },
      data: { priceInStore: 127 },
    });

    // Extracción nueva: el wholesale baja a 80 (proveedor bajó precio).
    // Esperado HOY con wholesale=80: ceil(80 * 1.27) = 102.
    // Diferencia con priceInStore (127) = 25 → drift real (> tolerancia 0.5).
    const job = await createTestExtractionJob(user.id, provider.id);
    await createTestExtractedProduct(job.id, provider.id, {
      sku: "DRIFT-001",
      name: "Producto cambió de precio",
      wholesalePrice: 80,
    });

    await upsertCatalogProducts(job.id, testPrisma);

    // cp ya tiene el wholesale nuevo.
    const cpAfter = await testPrisma.catalogProduct.findUnique({ where: { id: cp.id } });
    expect(cpAfter?.wholesalePrice).toBe(80);

    // ← LA ASERCIÓN CRÍTICA: la pp quedó marcada como OUTDATED + pendingSync.
    // Hoy esta línea FALLA porque upsertCatalogProducts no llama a
    // markPublicationsDrift. Con el fix, debe pasar.
    const pubAfter = await testPrisma.productPublication.findFirst({
      where: { catalogProductId: cp.id },
    });
    expect(pubAfter?.pendingSync).toBe(true);
    expect(pubAfter?.syncStatus).toBe("OUTDATED");

    // Y el EventLog del fix.
    const driftEvent = await testPrisma.eventLog.findFirst({
      where: { type: "PRODUCT_MARKED_OUTDATED" },
    });
    expect(driftEvent).not.toBeNull();
  });

  it("2. RE-EXTRACCIÓN SIN CAMBIO: mismo wholesale → pp NO se marca (no ruido)", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id, { skuPrefix: "T-" });
    await createTestStore(user.id);
    await testPrisma.pricingRule.create({
      data: {
        userId: user.id,
        name: "Margen Test",
        scope: "PROVIDER",
        scopeId: provider.id,
        marginPercent: 27,
        method: "MARKUP_ON_COST",
        roundingMode: "CEIL",
        isActive: true,
        priority: 0,
      },
    });

    const cp = await createTestCatalogProduct(user.id, provider.id, {
      sku: "NO-CHANGE-001",
      wholesalePrice: 100,
      internalStatus: "PUBLISHED",
    });
    const stores = await testPrisma.store.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } });
    const primaryStore = stores[0];
    await createTestPublication(cp.id, primaryStore.id, {
      sku: "T-NO-CHANGE-001",
      externalSku: "T-NO-CHANGE-001",
      externalProductId: "55556",
      status: "ACTIVE",
      syncStatus: "SYNCED",
      pendingSync: false,
    });
    await testPrisma.productPublication.updateMany({
      where: { catalogProductId: cp.id },
      data: { priceInStore: 127 },
    });

    // Extracción con el MISMO wholesale (100). No cambió nada de precio.
    const job = await createTestExtractionJob(user.id, provider.id);
    await createTestExtractedProduct(job.id, provider.id, {
      sku: "NO-CHANGE-001",
      name: "Producto sin cambio",
      wholesalePrice: 100,
    });

    await upsertCatalogProducts(job.id, testPrisma);

    const pubAfter = await testPrisma.productPublication.findFirst({
      where: { catalogProductId: cp.id },
    });
    // No cambió wholesale → NO marca drift → pp permanece SYNCED.
    expect(pubAfter?.pendingSync).toBe(false);
    expect(pubAfter?.syncStatus).toBe("SYNCED");

    // Y no se emitió el evento del fix.
    const driftEvent = await testPrisma.eventLog.findFirst({
      where: { type: "PRODUCT_MARKED_OUTDATED" },
    });
    expect(driftEvent).toBeNull();
  });

  it("3. PRODUCTO NUEVO en la extracción: no había cp → no se marca drift (no hay pp para marcar)", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id, { skuPrefix: "T-" });
    await createTestStore(user.id);
    await testPrisma.pricingRule.create({
      data: {
        userId: user.id,
        name: "Margen Test",
        scope: "PROVIDER",
        scopeId: provider.id,
        marginPercent: 27,
        method: "MARKUP_ON_COST",
        roundingMode: "CEIL",
        isActive: true,
        priority: 0,
      },
    });

    // No hay cps en el catálogo. La extracción trae un sku totalmente nuevo.
    const job = await createTestExtractionJob(user.id, provider.id);
    await createTestExtractedProduct(job.id, provider.id, {
      sku: "BRAND-NEW-001",
      name: "Producto nuevo",
      wholesalePrice: 50,
    });

    await upsertCatalogProducts(job.id, testPrisma);

    // Se creó el cp.
    const cpCount = await testPrisma.catalogProduct.count({ where: { userId: user.id } });
    expect(cpCount).toBe(1);

    // Pero NO se emitió PRODUCT_MARKED_OUTDATED (no había pp para marcar).
    const driftEvent = await testPrisma.eventLog.findFirst({
      where: { type: "PRODUCT_MARKED_OUTDATED" },
    });
    expect(driftEvent).toBeNull();
  });
});
