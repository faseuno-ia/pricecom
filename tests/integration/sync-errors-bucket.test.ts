// 1A.2-kpi — predicado compartido del bucket "Errores" de sync.
// SYNC_ERRORS_WHERE = syncStatus IN (ERROR, ERROR_SKU_CONFLICT). Lo usan KPI Mi
// Tienda, API Mi Tienda, chip/filtro "Errores" y dashboard, para que los cuatro
// cuenten EXACTAMENTE lo mismo. Acá se valida que cuenta los dos terminales y NO
// los PENDING_SYNC (que tienen su propio bucket "Pend. sync") ni SYNCED/OUTDATED.

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
import { SYNC_ERRORS_WHERE } from "@/lib/store/sync-buckets";

describe("SYNC_ERRORS_WHERE — bucket Errores por syncStatus", () => {
  beforeEach(async () => { await truncateAll(); });
  afterAll(async () => { await testPrisma.$disconnect(); });

  it("cuenta ERROR y ERROR_SKU_CONFLICT, NO PENDING_SYNC / SYNCED / OUTDATED", async () => {
    const user = await createTestUser();
    const provider = await createTestProvider(user.id);
    const { store } = await createTestStore(user.id);

    async function pub(sku: string, syncStatus: NonNullable<Parameters<typeof createTestPublication>[2]>["syncStatus"]) {
      const cp = await createTestCatalogProduct(user.id, provider.id, { sku });
      await createTestPublication(cp.id, store.id, { status: "ACTIVE", syncStatus });
    }
    await pub("E1", "ERROR");
    await pub("E2", "ERROR");
    await pub("SK1", "ERROR_SKU_CONFLICT");
    await pub("P1", "PENDING_SYNC");
    await pub("O1", "OUTDATED");
    await pub("S1", "SYNCED");

    const errores = await testPrisma.productPublication.count({
      where: { storeId: store.id, ...SYNC_ERRORS_WHERE },
    });
    // 2 ERROR + 1 ERROR_SKU_CONFLICT = 3 (excluye PENDING_SYNC, OUTDATED, SYNCED).
    expect(errores).toBe(3);

    // El PENDING_SYNC existe pero NO entra en Errores (vive en "Pend. sync").
    const pending = await testPrisma.productPublication.count({
      where: { storeId: store.id, syncStatus: "PENDING_SYNC" },
    });
    expect(pending).toBe(1);
    const erroresPubs = await testPrisma.productPublication.findMany({
      where: { storeId: store.id, ...SYNC_ERRORS_WHERE },
      select: { syncStatus: true },
    });
    expect(erroresPubs.every((p) => p.syncStatus !== "PENDING_SYNC")).toBe(true);
  });
});
