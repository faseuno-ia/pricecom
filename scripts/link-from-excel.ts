// One-off: procesa el Excel productos-a-vincular.xlsx que el cliente completó.
// 374 filas: 10 a eliminar (DELETE_SKUS) + 364 a vincular contra el proveedor
// real (resuelve / crea CatalogProduct + reasigna publication Mi stock cuando
// corresponde + crea ProductPublication si no había + push a Woo si tenía
// precio activo + marca unmatched.resolved=true).
//
// Uso:
//   npx tsx scripts/link-from-excel.ts                       # dry-run
//   npx tsx scripts/link-from-excel.ts --apply               # ejecuta
//   npx tsx scripts/link-from-excel.ts --excel "C:/path.xlsx"

import { PrismaClient } from "@prisma/client";
import ExcelJS from "exceljs";
import path from "node:path";
import { WooCommerceClient } from "../lib/integrations/woocommerce/client";
import { pauseProductInWoo } from "../lib/integrations/woocommerce/publication-service";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

const excelArgIdx = process.argv.indexOf("--excel");
const EXCEL_PATH =
  excelArgIdx >= 0 && process.argv[excelArgIdx + 1]
    ? process.argv[excelArgIdx + 1]
    : "C:/Users/Daniel/Downloads/productos-a-vincular.xlsx";

const DELETE_SKUS = new Set([
  "EF42",
  "EF73",
  "EF77",
  "EF85",
  "GAB103",
  "JOR632",
  "EF27",
  "EF106",
  "1344",
  "EF23",
]);

// Alias del nombre de proveedor en el Excel → nombre exacto en DB.
const PROVIDER_ALIAS: Record<string, string> = {
  IMPOTEKNO: "IMPOTEKNO",
  "TOY PALACE": "TOYS PALACE",
  BAZAR380: "BAZAR 380",
};

interface Row {
  rowIdx: number;
  woo: string; // SKU Comercial
  name: string;
  price: number | null;
  externalStatus: string | null;
  supplierSku: string | null; // null si 0, #N/A o vacío
  providerNameRaw: string;
  providerDbName: string | null; // null si no hay alias
}

function parseRow(raw: ExcelJS.Row, rowIdx: number): Row | null {
  const woo = String(raw.getCell(1).value ?? "").trim();
  if (!woo) return null;
  const name = String(raw.getCell(2).value ?? "").trim();
  const priceVal = raw.getCell(3).value;
  const price =
    typeof priceVal === "number" && Number.isFinite(priceVal) && priceVal > 0
      ? priceVal
      : null;
  const externalStatus = (raw.getCell(4).value as string | null) ?? null;
  const supplierRaw = raw.getCell(5).value;
  const supplierStr =
    supplierRaw == null ? "" : String(supplierRaw).trim();
  const supplierSku =
    supplierStr === "" ||
    supplierStr === "0" ||
    supplierStr.toUpperCase() === "#N/A"
      ? null
      : supplierStr;
  const providerNameRaw = String(raw.getCell(6).value ?? "").trim();
  const providerDbName = PROVIDER_ALIAS[providerNameRaw] ?? null;
  return {
    rowIdx,
    woo,
    name,
    price,
    externalStatus,
    supplierSku,
    providerNameRaw,
    providerDbName,
  };
}

async function main() {
  console.log(APPLY ? "MODO: APLICAR" : "MODO: DRY-RUN (sin escribir). Usar --apply.\n");
  console.log(`Excel: ${EXCEL_PATH}\n`);

  const user = await prisma.user.findUnique({
    where: { email: "admin@pricecom.com" },
    select: { id: true },
  });
  if (!user) throw new Error("admin@pricecom.com no encontrado");

  const store = await prisma.store.findFirst({
    where: { userId: user.id },
    include: { integrations: { orderBy: { createdAt: "desc" }, take: 1 } },
  });
  if (!store) throw new Error("no store");
  const integration = store.integrations[0];

  // Cliente Woo (solo se usa para deletes y pauseProductInWoo).
  let wooClient: WooCommerceClient | null = null;
  if (integration) {
    try {
      wooClient = WooCommerceClient.fromIntegration({
        storeUrl: store.url,
        consumerKeyEncrypted: integration.consumerKeyEncrypted,
        consumerSecretEncrypted: integration.consumerSecretEncrypted,
      });
    } catch (e) {
      console.warn("⚠ no se pudo construir WooClient:", (e as Error).message);
    }
  }

  const providers = await prisma.provider.findMany({
    where: { userId: user.id },
    select: { id: true, name: true, providerType: true },
  });
  const providerByName = new Map(providers.map((p) => [p.name, p]));
  const ownStock = providers.find((p) => p.providerType === "OWN_STOCK");
  if (!ownStock) throw new Error("provider OWN_STOCK no encontrado");

  // ─── Lectura Excel ──────────────────────────────────────────────────────
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(EXCEL_PATH);
  const sheet = wb.worksheets[0];
  const rows: Row[] = [];
  for (let i = 2; i <= sheet.rowCount; i++) {
    const r = parseRow(sheet.getRow(i), i);
    if (r) rows.push(r);
  }
  console.log(`Filas leídas: ${rows.length}`);

  const toDelete = rows.filter((r) => DELETE_SKUS.has(r.woo));
  const toLink = rows.filter(
    (r) => !DELETE_SKUS.has(r.woo) && r.supplierSku != null
  );
  const skipped = rows.filter(
    (r) => !DELETE_SKUS.has(r.woo) && r.supplierSku == null
  );

  console.log(`  · A eliminar (lista de 10): ${toDelete.length}`);
  console.log(`  · A vincular:               ${toLink.length}`);
  console.log(`  · Saltadas (no SKU prov):   ${skipped.length}`);

  // Aliases no resueltos.
  const providerNotMatched = new Set<string>();
  for (const r of toLink) {
    if (!r.providerDbName || !providerByName.has(r.providerDbName)) {
      providerNotMatched.add(r.providerNameRaw);
    }
  }
  if (providerNotMatched.size > 0) {
    console.log(`\n⚠ Providers sin alias resuelto:`);
    for (const n of providerNotMatched) console.log(`    "${n}"`);
    return; // sin alias no avanzo
  }

  // ─── Pre-análisis (dry-run stats) ─────────────────────────────────────
  console.log("\n─── Pre-análisis ───");

  // Para los links: cuántos van a hit existing vs create + reasign + push.
  let willCreateCatalog = 0;
  let willUpdateCatalog = 0;
  let willReassignFromOwnStock = 0;
  let willCreatePublication = 0;
  let willPushToWoo = 0;
  let linkSkipped = 0;

  // Cargo de antemano todo lo que voy a necesitar para no martillar la DB
  // con miles de roundtrips: un map por provider+sku y otro por publicationSku.
  const allSkus = new Set<string>();
  const allPubSkus = new Set<string>();
  for (const r of toLink) {
    if (r.supplierSku) allSkus.add(r.supplierSku);
    allPubSkus.add(r.woo);
  }
  // También incluimos las SKUs de delete para que byPubSkuOwnStock las capture.
  for (const r of toDelete) allPubSkus.add(r.woo);
  const candidateCatalogs = await prisma.catalogProduct.findMany({
    where: {
      userId: user.id,
      OR: [
        { sku: { in: Array.from(allSkus) } },
        { publicationSku: { in: Array.from(allPubSkus) } },
      ],
    },
    select: {
      id: true,
      sku: true,
      publicationSku: true,
      providerId: true,
      provider: { select: { providerType: true } },
      publications: { select: { id: true, externalProductId: true, storeId: true } },
    },
  });
  // Index: por providerId+sku, por publicationSku (todos los providers).
  const byProviderSku = new Map<string, typeof candidateCatalogs>();
  const byPubSkuOwnStock = new Map<string, (typeof candidateCatalogs)[number]>();
  for (const c of candidateCatalogs) {
    if (c.sku) {
      const key = `${c.providerId}|${c.sku}`;
      const list = byProviderSku.get(key) ?? [];
      list.push(c);
      byProviderSku.set(key, list);
    }
    if (c.publicationSku && c.provider.providerType === "OWN_STOCK") {
      byPubSkuOwnStock.set(c.publicationSku, c);
    }
  }

  const linkDecisions = toLink.map((r) => {
    const provider = providerByName.get(r.providerDbName!)!;
    const existing =
      candidateCatalogs.find(
        (c) =>
          c.providerId === provider.id &&
          (c.sku === r.supplierSku || c.publicationSku === r.woo)
      ) ?? null;
    const ownStockMatch = byPubSkuOwnStock.get(r.woo) ?? null;
    const willCreate = !existing;
    const needsReassign =
      ownStockMatch != null &&
      ownStockMatch.publications.length > 0 &&
      (existing?.id ?? "X") !== ownStockMatch.id;
    const needsPublication =
      (existing?.publications.length ?? 0) === 0 && !needsReassign;
    const willPush = r.price != null && r.price > 0;
    return {
      row: r,
      provider,
      existing,
      ownStockMatch,
      willCreate,
      needsReassign,
      needsPublication,
      willPush,
    };
  });

  for (const d of linkDecisions) {
    if (d.willCreate) willCreateCatalog++;
    else willUpdateCatalog++;
    if (d.needsReassign) willReassignFromOwnStock++;
    if (d.needsPublication) willCreatePublication++;
    if (d.willPush) willPushToWoo++;
  }

  console.log(`Links a CatalogProduct existente: ${willUpdateCatalog}`);
  console.log(`Links creando CatalogProduct:     ${willCreateCatalog}`);
  console.log(`Reasignaciones desde Mi stock:    ${willReassignFromOwnStock}`);
  console.log(`Publications a crear (sin Mi stock match): ${willCreatePublication}`);
  console.log(`Pushes a Woo (price > 0):         ${willPushToWoo}`);

  // Deletes: pre-análisis.
  console.log("\n─── Deletes (lista de 10) ───");
  const deleteDecisions = await Promise.all(
    toDelete.map(async (r) => {
      const unmatched = await prisma.unmatchedStoreProduct.findFirst({
        where: { storeId: store.id, externalSku: r.woo },
        select: {
          id: true,
          externalProductId: true,
          externalStatus: true,
          resolved: true,
        },
      });
      const ownCp = byPubSkuOwnStock.get(r.woo) ?? null;
      const wooDeletable =
        unmatched?.externalProductId != null &&
        unmatched.externalStatus !== "private";
      return { row: r, unmatched, ownCp, wooDeletable };
    })
  );
  for (const d of deleteDecisions) {
    const u = d.unmatched;
    const woo = u?.externalProductId ?? "—";
    console.log(
      `  ${d.row.woo.padEnd(8)} unmatched=${u?.id ?? "(no)"} woo=${woo} extStatus=${u?.externalStatus ?? "—"} ownCp=${d.ownCp?.id ?? "(no)"} wooDeletable=${d.wooDeletable}`
    );
  }

  if (!APPLY) {
    console.log("\n→ Dry-run. Re-correr con --apply para escribir.");
    return;
  }

  // ════════════════════════════════════════════════════════════════════
  //                              APPLY
  // ════════════════════════════════════════════════════════════════════

  // ─── Deletes ────────────────────────────────────────────────────────
  console.log("\n─── Aplicando deletes ───");
  let dDeletedInWoo = 0;
  let dOwnCpDeleted = 0;
  let dUnmatchedResolved = 0;
  for (const d of deleteDecisions) {
    const { row, unmatched, ownCp, wooDeletable } = d;
    let didWork = false;
    try {
      // 1. Borrar en Woo si corresponde.
      if (wooDeletable && unmatched && wooClient) {
        const wooId = Number(unmatched.externalProductId);
        if (Number.isFinite(wooId)) {
          try {
            await wooClient.deleteProduct(wooId, true);
            dDeletedInWoo++;
            didWork = true;
            console.log(`  ✓ ${row.woo} woo=${wooId} eliminado en Woo`);
          } catch (e) {
            console.log(`  ⚠ ${row.woo} woo=${wooId} delete Woo falló: ${(e as Error).message}`);
          }
        }
      }
      // 2. OWN_STOCK CatalogProduct + su publication.
      if (ownCp) {
        await prisma.$transaction(async (tx) => {
          for (const pub of ownCp.publications) {
            await tx.eventLog.updateMany({
              where: { publicationId: pub.id },
              data: { publicationId: null },
            });
            await tx.productPublication.delete({ where: { id: pub.id } });
          }
          // EventLog.productId también tiene FK contra CatalogProduct.id.
          await tx.eventLog.updateMany({
            where: { productId: ownCp.id },
            data: { productId: null },
          });
          await tx.catalogProduct.delete({ where: { id: ownCp.id } });
        });
        dOwnCpDeleted++;
        didWork = true;
        console.log(`  ✓ ${row.woo} OWN_STOCK cp ${ownCp.id} eliminado`);
      }
      // 3. Marcar unmatched resolved.
      if (unmatched && !unmatched.resolved) {
        await prisma.unmatchedStoreProduct.update({
          where: { id: unmatched.id },
          data: { resolved: true },
        });
        dUnmatchedResolved++;
        didWork = true;
      }
      // 4. Log solo si hubo trabajo real — re-runs no duplican audit trail.
      if (!didWork) continue;
      await prisma.eventLog.create({
        data: {
          source: "USER",
          severity: "INFO",
          type: "PUBLICATION_DELETED_ORPHAN",
          title: `Producto descartado desde Excel — ${row.woo}`,
          userId: user.id,
          storeId: store.id,
          metadata: {
            sku: row.woo,
            wooDeletable,
            externalProductId: unmatched?.externalProductId ?? null,
            ownCpId: ownCp?.id ?? null,
          },
        },
      });
    } catch (e) {
      console.log(`  ✗ ${row.woo} error: ${(e as Error).message}`);
    }
  }
  console.log(
    `Deletes: ${dDeletedInWoo} Woo · ${dOwnCpDeleted} OWN_STOCK · ${dUnmatchedResolved} unmatched resolved`
  );

  // ─── Links ──────────────────────────────────────────────────────────
  console.log(`\n─── Aplicando links (${linkDecisions.length}) ───`);
  let lCreated = 0;
  let lUpdated = 0;
  let lReassigned = 0;
  let lPubCreated = 0;
  let lPushed = 0;
  let lPushErrors = 0;
  let lErrors = 0;

  // Cache de unmatched por externalSku para no buscar 1 por 1.
  const unmatchedRows = await prisma.unmatchedStoreProduct.findMany({
    where: {
      storeId: store.id,
      externalSku: { in: linkDecisions.map((d) => d.row.woo) },
    },
    select: {
      id: true,
      externalSku: true,
      externalProductId: true,
      externalStatus: true,
      price: true,
      stockQuantity: true,
      permalink: true,
      resolved: true,
    },
  });
  const unmatchedBySku = new Map(unmatchedRows.map((u) => [u.externalSku ?? "", u]));

  let processed = 0;
  for (const d of linkDecisions) {
    processed++;
    if (processed % 50 === 0) {
      console.log(`  ... ${processed}/${linkDecisions.length}`);
    }
    const r = d.row;
    try {
      // Paso A — resolver/crear el CatalogProduct del proveedor real.
      let catalogId: string;
      if (d.existing) {
        await prisma.catalogProduct.update({
          where: { id: d.existing.id },
          data: {
            publicationSku: r.woo,
            supplierStatus: "SUPPLIER_REMOVED",
            internalStatus: "PAUSED",
            pausedBySystem: true,
          },
        });
        catalogId = d.existing.id;
        lUpdated++;
      } else {
        const created = await prisma.catalogProduct.create({
          data: {
            userId: user.id,
            providerId: d.provider.id,
            sku: r.supplierSku!,
            publicationSku: r.woo,
            supplierName: r.name || r.woo,
            supplierStatus: "SUPPLIER_REMOVED",
            internalStatus: "PAUSED",
            pausedBySystem: true,
            stockSource: "SUPPLIER",
            sourceType: "MANUAL",
            lastSeenAt: new Date(),
            ...(r.price != null && r.price > 0 ? { finalPrice: r.price } : {}),
          },
          select: { id: true },
        });
        catalogId = created.id;
        lCreated++;
      }

      // Paso B — si hay CP en OWN_STOCK con este publicationSku, reasignar
      // publication al proveedor real y borrar el OWN_STOCK. Antes del delete
      // del CatalogProduct hay que desligar los EventLog (FK productId).
      if (d.ownStockMatch && d.ownStockMatch.id !== catalogId) {
        const ownPubs = d.ownStockMatch.publications;
        const ownStockId = d.ownStockMatch.id;
        await prisma.$transaction(async (tx) => {
          for (const pub of ownPubs) {
            await tx.productPublication.update({
              where: { id: pub.id },
              data: { catalogProductId: catalogId },
            });
          }
          await tx.eventLog.updateMany({
            where: { productId: ownStockId },
            data: { productId: null },
          });
          await tx.catalogProduct.delete({ where: { id: ownStockId } });
        });
        if (ownPubs.length > 0) lReassigned++;
      }

      // Paso C — crear ProductPublication si todavía no existe.
      const pubExists = await prisma.productPublication.findUnique({
        where: {
          catalogProductId_storeId: {
            catalogProductId: catalogId,
            storeId: store.id,
          },
        },
        select: { id: true, externalProductId: true },
      });
      let publicationId: string | null = pubExists?.id ?? null;
      let publicationExternalProductId: string | null =
        pubExists?.externalProductId ?? null;
      if (!pubExists) {
        const u = unmatchedBySku.get(r.woo);
        const newPub = await prisma.productPublication.create({
          data: {
            catalogProductId: catalogId,
            storeId: store.id,
            status: "PAUSED",
            syncStatus: "SYNCED",
            pendingSync: false,
            externalProductId: u?.externalProductId ?? null,
            externalSku: u?.externalSku ?? r.woo,
            externalStatus: u?.externalStatus ?? null,
            externalUrl: u?.permalink ?? null,
            priceInStore: u?.price != null ? Number(u.price) : null,
            stockInStore: u?.stockQuantity ?? null,
            commercialTitle: r.name || null,
            lastSyncedAt: new Date(),
            lastSyncAt: new Date(),
          },
          select: { id: true, externalProductId: true },
        });
        publicationId = newPub.id;
        publicationExternalProductId = newPub.externalProductId;
        lPubCreated++;
      }

      // Paso D — push a Woo si tiene precio activo + externalProductId.
      if (r.price != null && r.price > 0 && publicationExternalProductId && wooClient) {
        const res = await pauseProductInWoo(prisma, wooClient, store.id, catalogId);
        if (res.success) lPushed++;
        else lPushErrors++;
      }

      // Paso E — marcar unmatched resolved.
      const u = unmatchedBySku.get(r.woo);
      if (u && !u.resolved) {
        await prisma.unmatchedStoreProduct.update({
          where: { id: u.id },
          data: { resolved: true },
        });
      }
    } catch (e) {
      lErrors++;
      console.log(`  ✗ ${r.woo} (${r.providerDbName}) error: ${(e as Error).message}`);
    }
  }

  console.log(`\n─── Resumen links ───`);
  console.log(`  CatalogProducts creados:        ${lCreated}`);
  console.log(`  CatalogProducts actualizados:   ${lUpdated}`);
  console.log(`  Reasignaciones desde Mi stock:  ${lReassigned}`);
  console.log(`  Publications creadas:           ${lPubCreated}`);
  console.log(`  Pushes a Woo OK:                ${lPushed}`);
  console.log(`  Pushes a Woo con error:         ${lPushErrors}`);
  console.log(`  Errores totales:                ${lErrors}`);
}

main()
  .catch((e) => {
    console.error("ERROR:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
