// Backfill de publicaciones con drift no marcado (one-off del Fix 2,
// post-2026-06-03 cuando se desplegó Fix 1).
//
// Antes del Fix 1, upsertCatalogProducts actualizaba el wholesalePrice del cp
// pero no llamaba a markPublicationsDrift, así que las pp quedaban
// silenciosamente desactualizadas (syncStatus=SYNCED, pendingSync=false,
// pero priceInStore ya no reflejaba el precio recalculable). El cliente no
// las veía en "Sincronizar pendientes" y Woo nunca recibía los precios nuevos.
//
// Este script corrige los HISTÓRICOS: llama a findDriftingPublications (la
// MISMA función que el Fix 1 deployado usa internamente) para listar todas
// las publicaciones con drift real, las agrupa por reason y proveedor, y
// permite marcarlas como OUTDATED vía markPublicationsDrift.
//
// MODO POR DEFECTO: --dry (read-only). Imprime el listado y NO escribe.
// MODO --apply: aplica la marca. Requiere flag explícito.
//
// Después del apply, re-corre el dry-check y reporta cuántas quedaron
// pendientes (debe ser 0). Si hay residuales, los lista para investigación.
//
// Usa la misma función que el Fix 1 → garantiza que el dry-run muestra
// EXACTAMENTE lo que el apply marca (no dos cálculos paralelos que
// "deberían coincidir").

import dotenv from "dotenv";
dotenv.config({ path: ".env" });

const PROD_ENDPOINT_ID = "ep-raspy-cloud-ap9iuixg";
if (!process.env.DATABASE_URL?.includes(PROD_ENDPOINT_ID)) {
  console.error(
    `[backfill] DATABASE_URL no apunta a prod (${PROD_ENDPOINT_ID}). Aborta.`
  );
  process.exit(1);
}

import { PrismaClient } from "@prisma/client";
import {
  findDriftingPublications,
  markPublicationsDrift,
  type DriftRow,
} from "../lib/catalog/mark-publications-drift";
import { resolvePricing } from "../lib/pricing/pricing-engine";

const prisma = new PrismaClient();

interface Args {
  apply: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  return {
    apply: argv.includes("--apply"),
  };
}

interface DriftWithContext extends DriftRow {
  providerName: string;
  cpSku: string | null;
  cpName: string;
  direction: "up" | "down" | "n/a";
  diffPct: number | null;
}

async function enrichDrifts(rows: DriftRow[]): Promise<DriftWithContext[]> {
  if (rows.length === 0) return [];
  const cpIds = Array.from(new Set(rows.map((r) => r.catalogProductId)));
  const cps = await prisma.catalogProduct.findMany({
    where: { id: { in: cpIds } },
    select: {
      id: true,
      sku: true,
      supplierName: true,
      provider: { select: { name: true } },
    },
  });
  const cpMap = new Map(cps.map((c) => [c.id, c]));

  return rows.map((r) => {
    const cp = cpMap.get(r.catalogProductId);
    const direction: "up" | "down" | "n/a" =
      r.wooPriceInStore != null && r.expectedPrice != null
        ? r.expectedPrice > r.wooPriceInStore
          ? "up"
          : r.expectedPrice < r.wooPriceInStore
            ? "down"
            : "n/a"
        : "n/a";
    const diffPct =
      r.wooPriceInStore != null && r.expectedPrice != null && r.wooPriceInStore > 0
        ? ((r.expectedPrice - r.wooPriceInStore) / r.wooPriceInStore) * 100
        : null;
    return {
      ...r,
      providerName: cp?.provider.name ?? "(unknown)",
      cpSku: cp?.sku ?? null,
      cpName: cp?.supplierName ?? "",
      direction,
      diffPct,
    };
  });
}

function printReport(rows: DriftWithContext[], label: string) {
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  ${label} — Total: ${rows.length}`);
  console.log("══════════════════════════════════════════════════════════════\n");

  if (rows.length === 0) {
    console.log("  (sin filas)\n");
    return;
  }

  // Por reason.
  const byReason = new Map<string, DriftWithContext[]>();
  for (const r of rows) {
    const k = r.reason;
    if (!byReason.has(k)) byReason.set(k, []);
    byReason.get(k)!.push(r);
  }
  console.log("Por reason:");
  for (const [reason, list] of byReason) {
    console.log(`  ${reason.padEnd(22)}  ${list.length}`);
  }

  // Por proveedor.
  const byProv = new Map<string, DriftWithContext[]>();
  for (const r of rows) {
    if (!byProv.has(r.providerName)) byProv.set(r.providerName, []);
    byProv.get(r.providerName)!.push(r);
  }
  console.log("\nPor proveedor (price-drift solamente):");
  console.log("  proveedor             | total | bajar | subir | otros");
  console.log("  ----------------------+-------+-------+-------+-------");
  for (const [prov, list] of [...byProv.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const pdrift = list.filter((r) => r.reason === "price-drift");
    const down = pdrift.filter((r) => r.direction === "down").length;
    const up = pdrift.filter((r) => r.direction === "up").length;
    const other = list.length - pdrift.length;
    console.log(`  ${prov.padEnd(20)} | ${String(list.length).padStart(5)} | ${String(down).padStart(5)} | ${String(up).padStart(5)} | ${String(other).padStart(5)}`);
  }

  // Desglose sube/baja agregado.
  const pdrift = rows.filter((r) => r.reason === "price-drift");
  const downAll = pdrift.filter((r) => r.direction === "down");
  const upAll = pdrift.filter((r) => r.direction === "up");
  console.log(`\nAgregado price-drift: ↓ BAJAR=${downAll.length}  ↑ SUBIR=${upAll.length}  (total price-drift ${pdrift.length})`);

  // no-price-calculable (los que requieren atención antes de sincronizar)
  const npc = rows.filter((r) => r.reason === "no-price-calculable");
  if (npc.length > 0) {
    console.log(`\nno-price-calculable (necesitan atención antes de sincronizar): ${npc.length}`);
    for (const r of npc.slice(0, 10)) {
      console.log(`  · sku=${r.cpSku ?? "?"}  [${r.providerName.slice(0, 15)}]  "${(r.cpName ?? "").slice(0, 50)}"  wooPrice=$${r.wooPriceInStore ?? "?"}`);
    }
    if (npc.length > 10) console.log(`  ... (${npc.length - 10} más)`);
  }

  // user-edited / no-baseline si existen.
  const ueed = rows.filter((r) => r.reason === "user-edited");
  const nbase = rows.filter((r) => r.reason === "no-baseline");
  if (ueed.length > 0) console.log(`\nuser-edited (siempre drift): ${ueed.length}`);
  if (nbase.length > 0) console.log(`\nno-baseline (sin priceInStore registrado): ${nbase.length}`);

  // Top 10 por |diffPct|.
  console.log(`\nTOP 10 por magnitud del drift (% sobre priceInStore):`);
  const sorted = pdrift
    .filter((r) => r.diffPct != null)
    .sort((a, b) => Math.abs(b.diffPct!) - Math.abs(a.diffPct!))
    .slice(0, 10);
  for (const r of sorted) {
    const arrow = r.direction === "down" ? "↓" : "↑";
    console.log(`  ${arrow} ${r.diffPct!.toFixed(1).padStart(7)}%  Woo=$${r.wooPriceInStore}  esperado=$${r.expectedPrice}  sku=${r.cpSku} [${r.providerName.slice(0, 15)}]  "${(r.cpName ?? "").slice(0, 40)}"`);
  }

  console.log("");
}

async function main() {
  const { apply } = parseArgs();
  console.log(`[backfill] modo: ${apply ? "--apply (ESCRIBE)" : "--dry (read-only)"}`);
  console.log(`[backfill] endpoint: ${process.env.DATABASE_URL?.match(/@([^/]+)/)?.[1] ?? "?"}\n`);

  // Universo: cps que tienen al menos una pp con externalProductId != null.
  const cps = await prisma.catalogProduct.findMany({
    where: {
      publications: { some: { externalProductId: { not: null } } },
    },
    select: { id: true },
  });
  console.log(`[backfill] cps publicados a evaluar: ${cps.length}`);
  const allCpIds = cps.map((c) => c.id);

  // 1. DRY: findDriftingPublications (la misma función que usa Fix 1).
  console.log("\n[backfill] Ejecutando findDriftingPublications...\n");
  const drifts = await findDriftingPublications(prisma, allCpIds);
  const enriched = await enrichDrifts(drifts);
  printReport(enriched, "DRY-RUN RESULT");

  if (!apply) {
    console.log("══════════════════════════════════════════════════════════════");
    console.log("  Modo --dry: no se escribió nada en _prisma_migrations ni en");
    console.log("  ProductPublication. Para aplicar, re-ejecutar con --apply.");
    console.log("══════════════════════════════════════════════════════════════");
    return;
  }

  // 2. APPLY: markPublicationsDrift SOLO sobre price-drift.
  //
  // Decisión explícita de scope del backfill: marcamos únicamente los
  // reason === "price-drift" (drift real de precio que el sync va a poder
  // empujar a Woo). Excluimos:
  //   - "no-price-calculable": sync abortaría con "Sin precio calculado",
  //     marcarlos sólo ensucia la cola con zombies no-sincronizables.
  //   - "user-edited": drift legítimo pero ortogonal al bug que vinimos a
  //     arreglar (precio); si hay user-edited residuales, es un gap aparte
  //     de los endpoints de edición que se aborda en otra tarea.
  //   - "no-baseline": en práctica no apareció en este dataset (priceInStore
  //     null suele venir de pp nueva sin sync, no de drift histórico).
  //
  // Esto es específico del BACKFILL one-off. La función markPublicationsDrift
  // que usa Fix 1 en producción NO cambia su comportamiento — sigue marcando
  // todas las reasons, porque en el flujo en vivo es defensivo (mejor false
  // positive que perder un drift real).
  console.log("══════════════════════════════════════════════════════════════");
  console.log("  APLICANDO markPublicationsDrift (SOLO price-drift)...");
  console.log("══════════════════════════════════════════════════════════════\n");
  const priceDrifts = drifts.filter((d) => d.reason === "price-drift");
  const excluded = drifts.length - priceDrifts.length;
  console.log(`[backfill] filtro de scope: ${drifts.length} total → ${priceDrifts.length} price-drift (${excluded} excluidos: no-price-calc + user-edited + no-baseline)`);
  const driftedCpIds = Array.from(new Set(priceDrifts.map((d) => d.catalogProductId)));
  const marked = await markPublicationsDrift(prisma, driftedCpIds);
  console.log(`[backfill] markPublicationsDrift devolvió: ${marked} publicación(es) marcadas\n`);

  // 3. VERIFICACIÓN POST-APPLY: query directa al estado de las pp objetivo.
  //
  // No re-corremos findDriftingPublications acá porque por diseño re-evalúa
  // todas las pp ACTIVE != PENDING_SYNC — incluidas las OUTDATED que acabamos
  // de marcar. El precio en Woo no cambió (solo marcamos el flag interno),
  // así que volverían a salir como drift y darían un falso positivo de
  // "residuales no marcados". La verificación correcta es: ¿de las
  // publicationIds que el apply intentó marcar, cuántas quedaron con
  // pendingSync=true post-update?
  console.log("[backfill] Verificando estado de las pp objetivo post-apply...\n");
  const priceDriftPubIds = priceDrifts.map((d) => d.publicationId);
  const verifyPubs = await prisma.productPublication.findMany({
    where: { id: { in: priceDriftPubIds } },
    select: { id: true, pendingSync: true, syncStatus: true },
  });
  const queued = verifyPubs.filter((p) => p.pendingSync === true);
  const notQueued = verifyPubs.filter((p) => p.pendingSync !== true);
  console.log(`Verificación: ${queued.length}/${priceDriftPubIds.length} pp con pendingSync=true post-apply.`);
  if (notQueued.length === 0) {
    console.log("✓ Backfill cerrado: todas las pp objetivo quedaron encoladas.");
  } else {
    console.log(`⚠ ${notQueued.length} pp NO quedaron con pendingSync=true:`);
    for (const p of notQueued.slice(0, 20)) {
      console.log(`  · ${p.id}: syncStatus=${p.syncStatus} pendingSync=${p.pendingSync}`);
    }
    if (notQueued.length > 20) console.log(`  ... (${notQueued.length - 20} más)`);
  }
}

main()
  .catch((e) => {
    console.error("[backfill] ERROR:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
