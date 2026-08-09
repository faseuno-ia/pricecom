// 2G-R8-Q2.1-B · writer explícito (§9.2), snapshot/diff (§3.1/§11), restore guard (§3.3).
import { describe, it, expect } from "vitest";
import { writePriceOnlyExplicit, type PartialWriteCatalogClient } from "@/lib/catalog/price-only-partial-write";
import { buildCatalogSnapshot, diffCatalogSnapshots, type CatalogSnapshotRow } from "@/lib/catalog/catalog-snapshot-diff";
import { buildRestorePlan, type RestoreMutableRow } from "@/lib/catalog/restore-guard";

// ── mock client que registra los updates ──
function mockClient(existing: Array<{ id: string; sku: string }>) {
  const updates: Array<{ id: string; data: any }> = [];
  const client: PartialWriteCatalogClient = {
    catalogProduct: {
      findMany: async ({ where }) => existing.filter((r) => where.sku.in.includes(r.sku)),
      update: async ({ where, data }) => { updates.push({ id: where.id, data }); return {}; },
    },
  };
  return { client, updates };
}

describe("§9.2 · writePriceOnlyExplicit — escribe SÓLO el set explícito", () => {
  const now = new Date("2026-08-09T00:00:00.000Z");

  it("W13/W14) escribe wholesalePrice+lastSeenAt+latestExtractedProductId sólo para los entries", async () => {
    const { client, updates } = mockClient([{ id: "id-A", sku: "A" }, { id: "id-B", sku: "B" }, { id: "id-C", sku: "C" }]);
    const r = await writePriceOnlyExplicit(client, {
      userId: "u", providerId: "p",
      entries: [
        { sku: "A", newPrice: 120, extractedProductId: "ep-A" },
        { sku: "B", newPrice: 80, extractedProductId: "ep-B" },
      ],
      lastSeenAt: now,
    });
    expect(r.written).toBe(2);
    expect(r.requested).toBe(2);
    expect(updates.map((u) => u.id).sort()).toEqual(["id-A", "id-B"]); // NO toca C
    expect(updates.find((u) => u.id === "id-A")!.data).toEqual({ wholesalePrice: 120, lastSeenAt: now, latestExtractedProductId: "ep-A" });
  });

  it("un sku del set sin fila de catálogo → NO se inserta (skipped)", async () => {
    const { client, updates } = mockClient([{ id: "id-A", sku: "A" }]);
    const r = await writePriceOnlyExplicit(client, {
      userId: "u", providerId: "p",
      entries: [{ sku: "A", newPrice: 120, extractedProductId: "ep-A" }, { sku: "NUEVO", newPrice: 200, extractedProductId: "ep-N" }],
      lastSeenAt: now,
    });
    expect(r.written).toBe(1);
    expect(r.skippedNonexistentSkus).toEqual(["NUEVO"]);
    expect(updates.length).toBe(1);
  });

  it("set vacío → 0 writes", async () => {
    const { client, updates } = mockClient([{ id: "id-A", sku: "A" }]);
    const r = await writePriceOnlyExplicit(client, { userId: "u", providerId: "p", entries: [], lastSeenAt: now });
    expect(r.written).toBe(0);
    expect(updates.length).toBe(0);
  });
});

// ── snapshot/diff ──
const row = (over: Partial<CatalogSnapshotRow> & { id: string }): CatalogSnapshotRow => ({
  id: over.id, sku: over.sku ?? over.id, wholesalePrice: "wholesalePrice" in over ? (over.wholesalePrice as number | null) : 100,
  lastSeenAt: over.lastSeenAt ?? "2026-08-01T00:00:00.000Z", latestExtractedProductId: over.latestExtractedProductId ?? "ep0",
  supplierName: over.supplierName ?? "N", supplierDescription: over.supplierDescription ?? null,
  supplierCategory: over.supplierCategory ?? null, imageUrl: over.imageUrl ?? null, productUrl: over.productUrl ?? "u",
  stock: over.stock ?? null, supplierStatus: over.supplierStatus ?? "ACTIVE", internalStatus: over.internalStatus ?? "PREPARED",
  pausedBySystem: over.pausedBySystem ?? false,
});

describe("§3.1/§11 · snapshot + diff", () => {
  it("snapshot determinístico e independiente del orden de entrada", () => {
    const a = buildCatalogSnapshot([row({ id: "1" }), row({ id: "2" })]);
    const b = buildCatalogSnapshot([row({ id: "2" }), row({ id: "1" })]);
    expect(a.snapshotSha256).toBe(b.snapshotSha256);
    expect(a.priceVectorSha256).toBe(b.priceVectorSha256);
    expect(a.rowCount).toBe(2);
  });

  it("W31) diff detecta exactamente los precios escritos y matchea el write-set esperado", () => {
    const pre = [row({ id: "1", wholesalePrice: 100 }), row({ id: "2", wholesalePrice: 50 }), row({ id: "3", wholesalePrice: 80 })];
    const post = [row({ id: "1", wholesalePrice: 110, sku: "1" }), row({ id: "2", wholesalePrice: 50, sku: "2" }), row({ id: "3", wholesalePrice: 88, sku: "3" })];
    const d = diffCatalogSnapshots(pre, post, ["1", "3"]);
    expect(d.wholesalePriceChangedCount).toBe(2);
    expect(d.changedPriceSkus).toEqual(["1", "3"]);
    expect(d.preflightMatchedActualWrites).toBe(true);
    expect(d.allNonPriceInvariantsZero).toBe(true);
    expect(d.existingPricedToNullCount).toBe(0);
  });

  it("W30) diff detecta mutación prohibida no-precio", () => {
    const pre = [row({ id: "1", internalStatus: "PREPARED" })];
    const post = [row({ id: "1", internalStatus: "PAUSED" })];
    const d = diffCatalogSnapshots(pre, post);
    expect(d.internalStatusChanged).toBe(1);
    expect(d.allNonPriceInvariantsZero).toBe(false);
  });

  it("diff detecta existing-priced-to-null y rows added/removed", () => {
    const pre = [row({ id: "1", wholesalePrice: 100 }), row({ id: "2" })];
    const post = [row({ id: "1", wholesalePrice: null }), row({ id: "3" })];
    const d = diffCatalogSnapshots(pre, post);
    expect(d.existingPricedToNullCount).toBe(1);
    expect(d.rowsRemoved).toBe(1); // id 2 desapareció
    expect(d.rowsAdded).toBe(1); // id 3 nuevo
    expect(d.allNonPriceInvariantsZero).toBe(false);
  });
});

// ── restore guard ──
const mrow = (id: string, price: number | null, ls = "L0", ep = "ep0"): RestoreMutableRow =>
  ({ id, sku: id, wholesalePrice: price, lastSeenAt: ls, latestExtractedProductId: ep });

describe("§3.3 · restore guard (fail-closed)", () => {
  it("W27) current == expectedPost → restaura a pre-run", () => {
    const preRun = [mrow("1", 100, "L0", "ep0")];
    const expectedPost = [mrow("1", 110, "L1", "ep1")];
    const current = [mrow("1", 110, "L1", "ep1")]; // igual al esperado
    const plan = buildRestorePlan({ preRun, expectedPost, current });
    expect(plan.safe).toBe(true);
    expect(plan.rowsWouldRestore).toBe(1);
    expect(plan.plan[0].to).toEqual({ wholesalePrice: 100, lastSeenAt: "L0", latestExtractedProductId: "ep0" });
    expect(plan.conflictCount).toBe(0);
  });

  it("W28) una fila cambió después de la corrida → CONFLICTO → fail-closed (nada se restaura)", () => {
    const preRun = [mrow("1", 100), mrow("2", 200)];
    const expectedPost = [mrow("1", 110, "L1", "ep1"), mrow("2", 220, "L1", "ep1")];
    const current = [mrow("1", 110, "L1", "ep1"), mrow("2", 999, "LX", "epX")]; // 2 cambió por otra operación
    const plan = buildRestorePlan({ preRun, expectedPost, current });
    expect(plan.safe).toBe(false);
    expect(plan.conflictCount).toBe(1);
    expect(plan.conflicts[0].id).toBe("2");
  });

  it("fila ya en estado pre-run → no-op (no cuenta como restore ni conflicto)", () => {
    const preRun = [mrow("1", 100, "L0", "ep0")];
    const expectedPost = [mrow("1", 110, "L1", "ep1")];
    const current = [mrow("1", 100, "L0", "ep0")]; // ya está en pre-run
    const plan = buildRestorePlan({ preRun, expectedPost, current });
    expect(plan.safe).toBe(true);
    expect(plan.rowsAlreadyMatchingPreRun).toBe(1);
    expect(plan.rowsWouldRestore).toBe(0);
  });
});
