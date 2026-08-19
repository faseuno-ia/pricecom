// Flujo lazy SKU (Fase 3): cuando se publica por primera vez un CatalogProduct
// sin pp.sku, publishProductToWoo lo genera como provider.skuPrefix + cp.sku,
// lo persiste ANTES del push a Woo, y dispara SKU_ASSIGNED. Casos cubiertos:
//
//   1. CREATE feliz                 → genera, persiste, emite SKU_ASSIGNED + WOO_PRODUCT_CREATED
//   2. Colisión en PricEcom         → warning-only (no bloquea), emite SKU_COLLISION + publica
//   3. Colisión en Woo (guard 3)    → bloqueante, pp queda ERROR_SKU_CONFLICT + pendingSync=false
//   4. Sin sku raw (caso BAZAR 380) → falla con error claro, no publica
//
// Este es el MOLDE de los otros tests de flujo: arrange con factories + mock
// de Woo en las fronteras, act con la función REAL, assert sobre DB + sobre
// las llamadas al mock.

import "../setup/env";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
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
import { publishProductToWoo } from "@/lib/integrations/woocommerce/publication-service";
import { FIRST_PUBLISH_AUTHORITY } from "@/lib/publishing/first-publish-authority";

// C2-DESIGN-1 · estos 4 casos ejercitan el path CREATE = PRIMERA publicación, que desde el
// guardarraíl exige un par (providerId, storeId) explícitamente ELIGIBLE. El fixture usa un par
// REAL del seed, resuelto por CLAVE ESTABLE (nombre de proveedor × nombre de tienda) y NO por
// índice del array: un reordenamiento del seed no puede desviarlo en silencio a otro proveedor.
// Los ids NO se duplican acá — se leen de la autoridad.
//
// Si el par desaparece del seed o deja de ser ELIGIBLE, esto LANZA al importar el archivo y los
// 4 tests fallan de forma ruidosa e inconfundible.
const ELIGIBLE_PAIR = (() => {
  const entry = FIRST_PUBLISH_AUTHORITY.find(
    (e) =>
      e.providerName === "IMPOTEKNO" &&
      e.storeName === "ELECTROFAYS" &&
      e.decision === "ELIGIBLE",
  );
  if (!entry) {
    throw new Error(
      'lazy-sku.test.ts: el par ELIGIBLE "IMPOTEKNO × ELECTROFAYS" ya no existe en ' +
        "FIRST_PUBLISH_AUTHORITY. Estos tests son de PRIMERA publicación y necesitan un par E1: " +
        "actualizá el fixture con un par elegible vigente del seed.",
    );
  }
  return entry;
})();

// Builder de un WooProduct mock con shape suficiente para el código bajo test
// (solo lee id/sku/permalink, pero devolvemos un objeto válido por las dudas).
function mockWooProduct(id: number, sku: string) {
  return {
    id,
    sku,
    name: "Mocked product",
    status: "publish",
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

// Instancia de WooCommerceClient con credenciales dummy. Los métodos los pisa
// applyWooMock por caso.
function makeWooClient() {
  return new WooCommerceClient(
    "https://shop.example.test",
    "dummy-key",
    "dummy-secret"
  );
}

describe("publishProductToWoo — flujo lazy SKU", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it("1. CREATE feliz: genera TEK-003, persiste antes del push, emite SKU_ASSIGNED + WOO_PRODUCT_CREATED", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id, {
      id: ELIGIBLE_PAIR.providerId,
      skuPrefix: "TEK-",
    });
    const { store } = await createTestStore(user.id, { id: ELIGIBLE_PAIR.storeId });
    const cp = await createTestCatalogProduct(user.id, provider.id, {
      sku: "003",
      finalPrice: 1500,
    });

    const createCalls: Array<{ name: string; sku: string }> = [];
    const findCalls: string[] = [];
    const restore = applyWooMock({
      findProductsBySku: async (sku: string) => {
        findCalls.push(sku);
        return [];
      },
      createProduct: async (data: { name: string; sku: string }) => {
        createCalls.push({ name: data.name, sku: data.sku });
        return mockWooProduct(99001, data.sku);
      },
    });

    try {
      const result = await publishProductToWoo(
        testPrisma,
        makeWooClient(),
        store.id,
        cp.id,
        []
      );

      expect(result.success).toBe(true);
      expect(result.externalProductId).toBe(99001);
    } finally {
      restore();
    }

    // pp.sku quedó "TEK-003" persistido.
    const pub = await testPrisma.productPublication.findUnique({
      where: {
        catalogProductId_storeId: { catalogProductId: cp.id, storeId: store.id },
      },
    });
    expect(pub).not.toBeNull();
    expect(pub?.sku).toBe("TEK-003");
    expect(pub?.externalProductId).toBe("99001");
    expect(pub?.syncStatus).toBe("SYNCED");
    expect(pub?.pendingSync).toBe(false);

    // El SKU lo recibió el createProduct mock con el valor correcto antes del push.
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].sku).toBe("TEK-003");

    // Guard 3 pre-push: assertSkuNotInWoo se llamó UNA vez con el sku generado.
    expect(findCalls).toEqual(["TEK-003"]);

    // El cp transicionó a PUBLISHED.
    const cpAfter = await testPrisma.catalogProduct.findUnique({
      where: { id: cp.id },
    });
    expect(cpAfter?.internalStatus).toBe("PUBLISHED");

    // EventLog: SKU_ASSIGNED diferido (post-create) + WOO_PRODUCT_CREATED.
    const events = await testPrisma.eventLog.findMany({
      where: { productId: cp.id },
      orderBy: { createdAt: "asc" },
      select: { type: true, metadata: true },
    });
    const types = events.map((e) => e.type);
    expect(types).toContain("SKU_ASSIGNED");
    expect(types).toContain("WOO_PRODUCT_CREATED");
  });

  it("2. Colisión en PricEcom: warning-only, publica igual + emite SKU_COLLISION", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id, {
      id: ELIGIBLE_PAIR.providerId,
      skuPrefix: "TEK-",
    });
    const { store } = await createTestStore(user.id, { id: ELIGIBLE_PAIR.storeId });

    // Otro cp del MISMO user que ya tiene una pub con sku "TEK-003".
    const otherCp = await createTestCatalogProduct(user.id, provider.id, {
      sku: "003-other",
      finalPrice: 100,
    });
    await createTestPublication(otherCp.id, store.id, { sku: "TEK-003" });

    // Cp bajo test: distinto sku raw que generaría "TEK-003" cuando le agreguen prefix.
    const cp = await createTestCatalogProduct(user.id, provider.id, {
      sku: "003",
      finalPrice: 1500,
    });

    const restore = applyWooMock({
      findProductsBySku: async () => [], // Sin colisión en Woo
      createProduct: async (data: { sku: string }) =>
        mockWooProduct(99002, data.sku),
    });

    try {
      const result = await publishProductToWoo(
        testPrisma,
        makeWooClient(),
        store.id,
        cp.id,
        []
      );
      expect(result.success).toBe(true);
    } finally {
      restore();
    }

    // El cp bajo test SÍ se publicó con "TEK-003" (warning, no bloqueante).
    const pub = await testPrisma.productPublication.findUnique({
      where: {
        catalogProductId_storeId: { catalogProductId: cp.id, storeId: store.id },
      },
    });
    expect(pub?.sku).toBe("TEK-003");
    expect(pub?.externalProductId).toBe("99002");

    // SKU_COLLISION emitido (warning).
    const collisionLog = await testPrisma.eventLog.findFirst({
      where: { productId: cp.id, type: "SKU_COLLISION" },
    });
    expect(collisionLog).not.toBeNull();
    expect(collisionLog?.severity).toBe("WARNING");

    // Y la pub original sigue ahí con su sku — no se pisó.
    const otherPub = await testPrisma.productPublication.findUnique({
      where: {
        catalogProductId_storeId: {
          catalogProductId: otherCp.id,
          storeId: store.id,
        },
      },
    });
    expect(otherPub?.sku).toBe("TEK-003");
  });

  it("3. Colisión en Woo (guard 3): bloquea, pp queda ERROR_SKU_CONFLICT + pendingSync=false", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id, {
      id: ELIGIBLE_PAIR.providerId,
      skuPrefix: "TEK-",
    });
    const { store } = await createTestStore(user.id, { id: ELIGIBLE_PAIR.storeId });
    const cp = await createTestCatalogProduct(user.id, provider.id, {
      sku: "003",
      finalPrice: 1500,
    });
    // Para que el guard 3 persista syncStatus=ERROR_SKU_CONFLICT, la pub
    // debe existir (DRAFT sin externalProductId) — caso real "Publicar producto
    // que ya tenía pub DRAFT".
    await createTestPublication(cp.id, store.id, {
      status: "DRAFT",
      syncStatus: "READY",
    });

    let createCalled = false;
    const restore = applyWooMock({
      findProductsBySku: async () => [
        {
          id: 77777,
          sku: "TEK-003",
          name: "Otro producto en Woo con ese SKU",
          status: "publish",
          regular_price: "0.00",
          price: "0.00",
          stock_quantity: null,
          manage_stock: false,
          stock_status: "instock",
          permalink: "https://shop.example.test/?p=77777",
          images: [],
          categories: [],
          description: "",
        },
      ],
      createProduct: async () => {
        createCalled = true;
        return mockWooProduct(0, "");
      },
    });

    try {
      const result = await publishProductToWoo(
        testPrisma,
        makeWooClient(),
        store.id,
        cp.id,
        []
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain("SKU conflict in Woo");
    } finally {
      restore();
    }

    // createProduct NO se llamó — el guard bloqueó antes.
    expect(createCalled).toBe(false);

    // pp quedó marcada para sacar de la cola.
    const pub = await testPrisma.productPublication.findUnique({
      where: {
        catalogProductId_storeId: { catalogProductId: cp.id, storeId: store.id },
      },
    });
    expect(pub?.syncStatus).toBe("ERROR_SKU_CONFLICT");
    expect(pub?.pendingSync).toBe(false);
    expect(pub?.externalProductId).toBeNull();
    expect(pub?.syncError).toContain("ya existe en WooCommerce");

    // cp NO transicionó a PUBLISHED.
    const cpAfter = await testPrisma.catalogProduct.findUnique({
      where: { id: cp.id },
    });
    expect(cpAfter?.internalStatus).toBe("NOT_PUBLISHED");
  });

  it("4. Sin sku raw (caso BAZAR 380): falla con error claro, no publica, no genera SKU inválido", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id, {
      id: ELIGIBLE_PAIR.providerId,
      skuPrefix: "B380-",
    });
    const { store } = await createTestStore(user.id, { id: ELIGIBLE_PAIR.storeId });
    const cp = await createTestCatalogProduct(user.id, provider.id, {
      sku: null, // caso real: el scraper no capturó sku
      finalPrice: 1500,
    });

    let createCalled = false;
    let findCalled = false;
    const restore = applyWooMock({
      findProductsBySku: async () => {
        findCalled = true;
        return [];
      },
      createProduct: async () => {
        createCalled = true;
        return mockWooProduct(0, "");
      },
    });

    try {
      const result = await publishProductToWoo(
        testPrisma,
        makeWooClient(),
        store.id,
        cp.id,
        []
      );
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/sku del proveedor/i);
    } finally {
      restore();
    }

    // Falló antes del guard 3 y antes del create.
    expect(findCalled).toBe(false);
    expect(createCalled).toBe(false);

    // No se creó publication.
    const pub = await testPrisma.productPublication.findUnique({
      where: {
        catalogProductId_storeId: { catalogProductId: cp.id, storeId: store.id },
      },
    });
    expect(pub).toBeNull();

    // cp se quedó en NOT_PUBLISHED.
    const cpAfter = await testPrisma.catalogProduct.findUnique({
      where: { id: cp.id },
    });
    expect(cpAfter?.internalStatus).toBe("NOT_PUBLISHED");
  });
});
