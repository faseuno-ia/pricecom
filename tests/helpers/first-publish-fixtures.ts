// Fixtures compartidas por los tests de C2-DESIGN-1 (guardarraíl de primera publicación).
//
// Los identificadores son los REALES del seed (GATE2-SEED-PRECHECK, 2026-08-17) porque los
// tests tienen que ejercitar la autoridad tal como queda configurada en producción. Acá son
// datos de test; la autoridad de negocio vive en lib/publishing/first-publish-authority.ts.
//
// Ningún fixture toca la DB: todo alimenta a createFakePrisma (tests/helpers/fake-prisma.ts).

import type { FakeDb } from "./fake-prisma";

export const USER_ID = "cmp504wd40000t25nssc377rw";
export const STORE_ID = "cmpbws2z90001luzc2tsi5143";

/** ELIGIBLE en el seed. */
export const PROVIDER_IMPOTEKNO = "cmp3hop7700003mhu29jk9kxd";
/** INELIGIBLE explícito en el seed (Different Touch). */
export const PROVIDER_DT = "cms8554bw0002cxz7qm3buvwm";
/** Ausente del seed por decisión explícita (LACHIPELU - Vanesa, isActive=false). */
export const PROVIDER_LACHIPELU = "cmp8yrrxz0003v2l216axmacb";

export const STORE_URL = "https://shop.example.test";

export interface PublishFixtureOptions {
  providerId: string;
  /** null → no hay ProductPublication (primera publicación pura). */
  externalProductId?: string | null;
  /** true → existe la fila pero sin externalProductId (caso my-store sync). */
  publicationWithoutRemoteId?: boolean;
  stockSource?: "SUPPLIER" | "OWN" | "HYBRID";
  internalStatus?: string;
  catalogProductId?: string;
}

export const CATALOG_PRODUCT_ID = "cp-under-test";

function storeRows(): FakeDb {
  return {
    store: [
      {
        id: STORE_ID,
        userId: USER_ID,
        name: "ELECTROFAYS",
        url: STORE_URL,
        platform: "WOOCOMMERCE",
        isActive: true,
        integrations: [
          {
            id: "integration-1",
            storeId: STORE_ID,
            consumerKeyEncrypted: "enc-key",
            consumerSecretEncrypted: "enc-secret",
            status: "CONNECTED",
            createdAt: new Date("2026-01-01T00:00:00Z"),
          },
        ],
      },
    ],
    storeCategory: [],
    pricingRule: [],
    eventLog: [],
  };
}

/**
 * Un CatalogProduct publicable (tiene finalPrice ⇒ resolvePricing devuelve effectivePrice)
 * más la Store/integración necesarias. `provider` y `categories` van embebidos porque el fake
 * ignora `include`.
 */
export function buildPublishFixture(opts: PublishFixtureOptions): FakeDb {
  const catalogProductId = opts.catalogProductId ?? CATALOG_PRODUCT_ID;
  const publications: FakeDb["productPublication"] = [];

  if (opts.externalProductId || opts.publicationWithoutRemoteId) {
    publications.push({
      id: "pp-under-test",
      catalogProductId,
      storeId: STORE_ID,
      sku: opts.externalProductId ? "TEK-SKU-1" : null,
      externalSku: opts.externalProductId ? "TEK-SKU-1" : null,
      externalProductId: opts.externalProductId ?? null,
      externalStatus: opts.externalProductId ? "publish" : null,
      status: "ACTIVE",
      syncStatus: "SYNCED",
      pendingSync: false,
      priceInStore: opts.externalProductId ? 1500 : null,
      lastPushedPrice: opts.externalProductId ? 1500 : null,
      commercialTitle: null,
      commercialTitleUserEdited: false,
      commercialDescription: null,
      commercialDescriptionUserEdited: false,
      // Embebido para markPublicationsDrift, el select del sync route y el del endpoint de SKU.
      catalogProduct: {
        id: catalogProductId,
        userId: USER_ID,
        supplierName: "PRODUCTO DE PRUEBA",
        providerId: opts.providerId,
        internalStatus: opts.internalStatus ?? "PREPARED",
        wholesalePrice: 1000,
        manualMargin: null,
        finalPrice: 1500,
        assignedCategoryId: null,
        provider: { listDiscountPercent: 0 },
      },
    });
  }

  return {
    ...storeRows(),
    catalogProduct: [
      {
        id: catalogProductId,
        userId: USER_ID,
        providerId: opts.providerId,
        sku: "SKU-1",
        supplierName: "PRODUCTO DE PRUEBA",
        supplierDescription: null,
        commercialTitle: null,
        commercialDescription: null,
        wholesalePrice: 1000,
        manualMargin: null,
        finalPrice: 1500,
        assignedCategoryId: null,
        stock: "10",
        stockSource: opts.stockSource ?? "SUPPLIER",
        supplierStatus: "ACTIVE",
        internalStatus: opts.internalStatus ?? "PREPARED",
        pausedBySystem: false,
        sourceCatalogProductId: null,
        categories: [],
        provider: { listDiscountPercent: 0, skuPrefix: "TEK-" },
      },
    ],
    productPublication: publications,
  };
}

/**
 * Fixture del camino worker: un producto que vuelve de SUPPLIER_REMOVED con pausedBySystem=true
 * dispara handleReappeared → publishProductToWoo (upsert-catalog-products.ts:166).
 *
 * La ProductPublication existe SIN externalProductId ⇒ el branch de publication-service.ts:229
 * entra en CREATE ⇒ es primera publicación.
 *
 * `wholesalePrice` entrante == el del catálogo, a propósito: así `drifted` queda vacío y el
 * test no arrastra markPublicationsDrift, que no es parte de lo que se está probando.
 */
export function buildWorkerReappearFixture(providerId: string): FakeDb {
  const catalogProductId = "cp-worker-reappear";
  return {
    ...storeRows(),
    extractionJob: [
      {
        id: "job-1",
        userId: USER_ID,
        providerId,
        status: "RUNNING",
        products: [
          {
            id: "ep-1",
            jobId: "job-1",
            sku: "SKU-1",
            name: "Producto de prueba",
            description: null,
            wholesalePrice: 1000,
            stock: "10",
            category: null,
            imageUrl: null,
            productUrl: null,
          },
        ],
      },
    ],
    providerScraperConfig: [{ id: "cfg-1", providerId, catalogWriteMode: null }],
    catalogProduct: [
      {
        id: catalogProductId,
        userId: USER_ID,
        providerId,
        sku: "SKU-1",
        supplierName: "PRODUCTO DE PRUEBA",
        supplierDescription: null,
        commercialTitle: null,
        commercialDescription: null,
        wholesalePrice: 1000,
        manualMargin: null,
        finalPrice: 1500,
        assignedCategoryId: null,
        stock: "10",
        stockSource: "SUPPLIER",
        // Vuelve del removido ⇒ cameBackFromRemoved = true
        supplierStatus: "SUPPLIER_REMOVED",
        internalStatus: "PAUSED",
        pausedBySystem: true,
        sourceCatalogProductId: null,
        categories: [],
        provider: { listDiscountPercent: 0, skuPrefix: "TEK-" },
      },
    ],
    productPublication: [
      {
        id: "pp-worker-reappear",
        catalogProductId,
        storeId: STORE_ID,
        sku: null,
        externalSku: null,
        externalProductId: null,
        externalStatus: null,
        status: "ACTIVE",
        syncStatus: "SYNCED",
        pendingSync: false,
        priceInStore: null,
        lastPushedPrice: null,
        commercialTitle: null,
        commercialTitleUserEdited: false,
        commercialDescription: null,
        commercialDescriptionUserEdited: false,
        catalogProduct: {
          userId: USER_ID,
          providerId,
          internalStatus: "PAUSED",
          wholesalePrice: 1000,
          manualMargin: null,
          finalPrice: 1500,
          assignedCategoryId: null,
          provider: { listDiscountPercent: 0 },
        },
      },
    ],
  };
}

export const WORKER_CATALOG_PRODUCT_ID = "cp-worker-reappear";
