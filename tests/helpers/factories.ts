// Factories reusables para seed de tests de integración. Cada función
// inserta en la DB de test (testPrisma) con defaults sensatos + override
// parcial. Usar en arrange:
//
//   const user = await createTestUser();
//   const provider = await createTestProvider(user.id, { skuPrefix: "TEK-" });
//   const cp = await createTestCatalogProduct(user.id, provider.id, { sku: "003" });
//
// Reglas:
//   - Defaults cubren los campos NOT NULL del schema. El test sobrescribe lo
//     que le importa al caso.
//   - Cada factory devuelve el objeto creado (con id), no un Promise<void>.
//   - Los emails / sku /etc. dummy usan timestamp + index para evitar
//     colisiones entre runs aunque truncateAll esté entre tests.
//   - NO commitear "magic numbers" pricing acá — cada test que quiera
//     ejercitar pricing debe pasar finalPrice/wholesalePrice explícito.

import type {
  User,
  Provider,
  Store,
  StoreIntegration,
  CatalogProduct,
  ProductPublication,
  ExtractionJob,
  ExtractedProduct,
} from "@prisma/client";
import { testPrisma } from "../setup/db";

let seq = 0;
const uniq = () => `${Date.now()}-${++seq}`;

export interface UserOverrides {
  email?: string;
  password?: string;
  name?: string;
}

export async function createTestUser(
  overrides: UserOverrides = {}
): Promise<User> {
  return testPrisma.user.create({
    data: {
      email: overrides.email ?? `test-${uniq()}@example.test`,
      password: overrides.password ?? "hash-placeholder",
      name: overrides.name ?? null,
    },
  });
}

export interface ProviderOverrides {
  /** Id explícito. Sólo se usa cuando el test necesita un providerId ESPECÍFICO
   *  (ej. un par elegible de FIRST_PUBLISH_AUTHORITY). Por defecto lo genera Prisma. */
  id?: string;
  name?: string;
  providerType?: "SCRAPER" | "MANUAL" | "IMPORTED" | "OWN_STOCK";
  baseUrl?: string;
  skuPrefix?: string;
  listDiscountPercent?: number;
}

export async function createTestProvider(
  userId: string,
  overrides: ProviderOverrides = {}
): Promise<Provider> {
  return testPrisma.provider.create({
    data: {
      ...(overrides.id ? { id: overrides.id } : {}),
      userId,
      name: overrides.name ?? `TestProvider-${uniq()}`,
      providerType: overrides.providerType ?? "MANUAL",
      baseUrl: overrides.baseUrl ?? "https://example.test",
      skuPrefix: overrides.skuPrefix ?? "",
      ...(overrides.listDiscountPercent !== undefined
        ? { listDiscountPercent: overrides.listDiscountPercent }
        : {}),
    },
  });
}

export interface StoreOverrides {
  /** Id explícito. Ver ProviderOverrides.id. */
  id?: string;
  name?: string;
  platform?: "WOOCOMMERCE" | "SHOPIFY" | "TIENDANUBE";
  url?: string;
}

/**
 * Crea un Store + un StoreIntegration con credenciales dummy. Devuelve los
 * dos. Los tests que mockean WooCommerceClient no necesitan que las creds
 * sean reales — el cliente recibe valores arbitrarios y los métodos están
 * monkey-patched por applyWooMock.
 */
export async function createTestStore(
  userId: string,
  overrides: StoreOverrides = {}
): Promise<{ store: Store; integration: StoreIntegration }> {
  const store = await testPrisma.store.create({
    data: {
      ...(overrides.id ? { id: overrides.id } : {}),
      userId,
      name: overrides.name ?? `TestStore-${uniq()}`,
      platform: overrides.platform ?? "WOOCOMMERCE",
      url: overrides.url ?? "https://shop.example.test",
    },
  });
  const integration = await testPrisma.storeIntegration.create({
    data: {
      storeId: store.id,
      // No son credenciales reales — los tests siempre mockean el client.
      // Los valores tienen que pasar el shape esperado por decrypt(), pero
      // como nunca llamamos a fromIntegration en los tests, no importa.
      consumerKeyEncrypted: "dummy-key-encrypted",
      consumerSecretEncrypted: "dummy-secret-encrypted",
      status: "CONNECTED",
    },
  });
  return { store, integration };
}

export interface CatalogProductOverrides {
  sku?: string | null;
  publicationSku?: string | null;
  supplierName?: string;
  supplierDescription?: string | null;
  wholesalePrice?: number | null;
  finalPrice?: number | null;
  manualMargin?: number | null;
  commercialTitle?: string | null;
  commercialDescription?: string | null;
  stock?: string | null;
  internalStatus?:
    | "NOT_PUBLISHED"
    | "PREPARED"
    | "PUBLISHED"
    | "PAUSED"
    | "IGNORED";
  sourceType?: "SCRAPED" | "MANUAL" | "IMPORTED";
}

export async function createTestCatalogProduct(
  userId: string,
  providerId: string,
  overrides: CatalogProductOverrides = {}
): Promise<CatalogProduct> {
  return testPrisma.catalogProduct.create({
    data: {
      userId,
      providerId,
      sku: overrides.sku === undefined ? `SKU-${uniq()}` : overrides.sku,
      publicationSku: overrides.publicationSku ?? null,
      supplierName: overrides.supplierName ?? "Producto de prueba",
      supplierDescription: overrides.supplierDescription ?? null,
      wholesalePrice: overrides.wholesalePrice ?? null,
      finalPrice: overrides.finalPrice ?? null,
      manualMargin: overrides.manualMargin ?? null,
      commercialTitle: overrides.commercialTitle ?? null,
      commercialDescription: overrides.commercialDescription ?? null,
      stock: overrides.stock ?? null,
      internalStatus: overrides.internalStatus ?? "NOT_PUBLISHED",
      sourceType: overrides.sourceType ?? "MANUAL",
      lastSeenAt: new Date(),
    },
  });
}

export interface PublicationOverrides {
  sku?: string | null;
  externalSku?: string | null;
  externalProductId?: string | null;
  status?: "DRAFT" | "ACTIVE" | "PAUSED" | "ERROR";
  syncStatus?:
    | "READY"
    | "PENDING_SYNC"
    | "SYNCED"
    | "OUTDATED"
    | "ERROR"
    | "PAUSED"
    | "ERROR_SKU_CONFLICT";
  pendingSync?: boolean;
  commercialTitle?: string | null;
  commercialTitleUserEdited?: boolean;
  commercialDescription?: string | null;
  commercialDescriptionUserEdited?: boolean;
}

export interface ExtractionJobOverrides {
  status?: "PENDING" | "RUNNING" | "COMPLETED" | "FAILED" | "CANCELLED";
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

/**
 * Crea un ExtractionJob para alimentar a upsertCatalogProducts(jobId, prisma).
 * El job tiene userId + providerId — sin userId el upsert hace early return.
 */
export async function createTestExtractionJob(
  userId: string,
  providerId: string,
  overrides: ExtractionJobOverrides = {}
): Promise<ExtractionJob> {
  return testPrisma.extractionJob.create({
    data: {
      userId,
      providerId,
      status: overrides.status ?? "COMPLETED",
      startedAt: overrides.startedAt ?? new Date(),
      finishedAt:
        overrides.finishedAt === undefined ? new Date() : overrides.finishedAt,
    },
  });
}

export interface ExtractedProductOverrides {
  sku?: string | null;
  name?: string;
  description?: string | null;
  wholesalePrice?: number | null;
  stock?: string | null;
  productUrl?: string | null;
  imageUrl?: string | null;
}

/**
 * Crea una fila ExtractedProduct asociada a un ExtractionJob. Lo que
 * upsertCatalogProducts considera "viene en la extracción": el conjunto de
 * filas EP del jobId. Si el sku del CP no está en este conjunto, ese CP
 * "desapareció" en este job.
 */
export async function createTestExtractedProduct(
  jobId: string,
  providerId: string,
  overrides: ExtractedProductOverrides = {}
): Promise<ExtractedProduct> {
  return testPrisma.extractedProduct.create({
    data: {
      jobId,
      providerId,
      sku: overrides.sku === undefined ? `EXT-${uniq()}` : overrides.sku,
      name: overrides.name ?? "Producto extraído",
      description: overrides.description ?? null,
      wholesalePrice: overrides.wholesalePrice ?? null,
      stock: overrides.stock ?? null,
      productUrl: overrides.productUrl ?? null,
      imageUrl: overrides.imageUrl ?? null,
    },
  });
}

export async function createTestPublication(
  catalogProductId: string,
  storeId: string,
  overrides: PublicationOverrides = {}
): Promise<ProductPublication> {
  return testPrisma.productPublication.create({
    data: {
      catalogProductId,
      storeId,
      sku: overrides.sku ?? null,
      externalSku: overrides.externalSku ?? null,
      externalProductId: overrides.externalProductId ?? null,
      status: overrides.status ?? "DRAFT",
      syncStatus: overrides.syncStatus ?? "READY",
      pendingSync: overrides.pendingSync ?? false,
      commercialTitle: overrides.commercialTitle ?? null,
      commercialTitleUserEdited: overrides.commercialTitleUserEdited ?? false,
      commercialDescription: overrides.commercialDescription ?? null,
      commercialDescriptionUserEdited:
        overrides.commercialDescriptionUserEdited ?? false,
    },
  });
}
