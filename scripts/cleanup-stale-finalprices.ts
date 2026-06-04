// Limpieza de finalPrice "fantasma" creado el 2026-05-15 por un import de Excel
// que el cliente subió para corregir SKU comerciales pero que el importador
// también interpretó como override de finalPrice (alias "PRECIO WEB" mapeado a
// finalPrice en lib/catalog/import-aliases.ts:65-72).
//
// El cliente confirmó que NUNCA puso un precio manual; estos 385 valores son
// involuntarios. Resultado: la regla automática del proveedor no se aplica
// porque finalPrice override la pisa, y los precios en Woo quedaron
// congelados aunque el wholesale del scrape se mueva.
//
// Criterio (WHERE GENERALIZADO, verificado vía _diag-generalized-cleanup.ts):
//   finalPrice IS NOT NULL
//   AND wholesalePrice IS NOT NULL
//   AND manualMargin IS NULL
//   AND manualSourceNote IS NULL
//   AND sourceType IN ('SCRAPED', 'IMPORTED')
//
// Verificado que agarra 385 cps (384 IMPOTEKNO + 1 GABY JG-988) y excluye:
//   - 3 TOYS PALACE manuales (wholesale=null)
//   - 6 IMPOTEKNO manuales (wholesale=null)
//   - V-113803 (manualMargin=40)
//   - Todo otro proveedor.
//
// MODOS:
//   --dry (default): COUNT, breakdown por proveedor, 10 filas de muestra. NO escribe.
//   --apply: dump JSON backup PRIMERO, luego UPDATE, luego re-check 0.
//
// SEGURIDAD:
//   1. Aborta si DATABASE_URL no apunta al endpoint de prod.
//   2. En --apply, el dump JSON se escribe ANTES del UPDATE. Si el dump falla,
//      el UPDATE no se ejecuta.
//   3. El dump se valida (rows.length > 0 si el COUNT > 0).
//   4. El UPDATE corre dentro de una transacción Prisma con el SELECT del COUNT
//      para asegurar que el universo no cambió entre dump y update.
//   5. Tras el UPDATE, re-corre el SELECT — debe dar 0; si no, error.
//
// RECUPERACIÓN: el dump JSON guarda {id, finalPrice, wholesalePrice, providerName,
// sku, supplierName, sourceType} de cada fila. Si hace falta revertir, se puede
// restaurar individualmente con un script de revert.

import dotenv from "dotenv";
dotenv.config({ path: ".env" });

const PROD_ENDPOINT_ID = "ep-raspy-cloud-ap9iuixg";
if (!process.env.DATABASE_URL?.includes(PROD_ENDPOINT_ID)) {
  console.error(
    `[cleanup] DATABASE_URL no apunta a prod (${PROD_ENDPOINT_ID}). Aborta.`
  );
  process.exit(1);
}

import { PrismaClient, type Prisma } from "@prisma/client";
import { writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";

const prisma = new PrismaClient();

interface Args {
  apply: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  return { apply: argv.includes("--apply") };
}

// El WHERE generalizado, en un solo lugar — se usa idéntico en SELECT, dump y UPDATE.
const cleanupWhere = {
  finalPrice: { not: null },
  wholesalePrice: { not: null },
  manualMargin: null,
  manualSourceNote: null,
  sourceType: { in: ["SCRAPED", "IMPORTED"] as const },
} as const satisfies Prisma.CatalogProductWhereInput;

interface DumpRow {
  id: string;
  sku: string | null;
  supplierName: string;
  finalPrice: number;
  wholesalePrice: number;
  sourceType: string;
  providerName: string;
}

async function selectTargets(): Promise<DumpRow[]> {
  const cps = await prisma.catalogProduct.findMany({
    where: cleanupWhere,
    select: {
      id: true,
      sku: true,
      supplierName: true,
      finalPrice: true,
      wholesalePrice: true,
      sourceType: true,
      provider: { select: { name: true } },
    },
  });
  return cps.map((c) => ({
    id: c.id,
    sku: c.sku,
    supplierName: c.supplierName,
    finalPrice: Number(c.finalPrice!),
    wholesalePrice: Number(c.wholesalePrice!),
    sourceType: c.sourceType,
    providerName: c.provider.name,
  }));
}

function printSummary(rows: DumpRow[], label: string) {
  console.log(`\n══════ ${label} — Total: ${rows.length} ══════\n`);
  if (rows.length === 0) return;

  // Por proveedor.
  const byProv = new Map<string, number>();
  for (const r of rows) byProv.set(r.providerName, (byProv.get(r.providerName) ?? 0) + 1);
  console.log("  Por proveedor:");
  for (const [p, n] of [...byProv.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${p.padEnd(20)} ${n}`);
  }

  // Por sourceType.
  const byType = new Map<string, number>();
  for (const r of rows) byType.set(r.sourceType, (byType.get(r.sourceType) ?? 0) + 1);
  console.log("\n  Por sourceType:");
  for (const [t, n] of byType) console.log(`    ${t.padEnd(20)} ${n}`);

  // Sample.
  console.log("\n  Muestra (primeras 10):");
  for (const r of rows.slice(0, 10)) {
    console.log(
      `    · ${r.providerName.padEnd(12)} sku=${(r.sku ?? "?").padEnd(15)} finalPrice=$${r.finalPrice} ws=$${r.wholesalePrice}  "${r.supplierName.slice(0, 50)}"`
    );
  }
  if (rows.length > 10) console.log(`    ... (${rows.length - 10} más)`);
}

function writeBackupDump(rows: DumpRow[]): string {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(process.cwd(), "backups", `finalprices-cleanup-pre-${ts}.json`);
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const payload = {
    createdAt: new Date().toISOString(),
    whereCriteria: {
      finalPrice: "NOT NULL",
      wholesalePrice: "NOT NULL",
      manualMargin: "NULL",
      manualSourceNote: "NULL",
      sourceType: ["SCRAPED", "IMPORTED"],
    },
    count: rows.length,
    rows,
  };
  writeFileSync(path, JSON.stringify(payload, null, 2));
  console.log(`[cleanup] backup escrito: ${path}  (${rows.length} filas)`);
  return path;
}

async function main() {
  const { apply } = parseArgs();
  console.log(`[cleanup] modo: ${apply ? "--apply (ESCRIBE)" : "--dry (read-only)"}`);
  console.log(`[cleanup] endpoint: ${process.env.DATABASE_URL?.match(/@([^/]+)/)?.[1] ?? "?"}\n`);

  // 1. SELECT inicial.
  const targets = await selectTargets();
  console.log(`[cleanup] SELECT inicial: ${targets.length} cp(s) matchean el WHERE.`);
  printSummary(targets, "TARGETS DEL CLEANUP");

  if (!apply) {
    console.log(
      "\n══════════════════════════════════════════════════════════════\n" +
      "  Modo --dry: NO se escribió nada (ni backup ni UPDATE).\n" +
      "  Para aplicar: re-correr con --apply.\n" +
      "══════════════════════════════════════════════════════════════"
    );
    return;
  }

  // 2. APPLY: backup PRIMERO.
  if (targets.length === 0) {
    console.log("[cleanup] 0 targets, nada que limpiar. Aborto sin escribir.");
    return;
  }
  console.log("\n[cleanup] Escribiendo backup dump ANTES del UPDATE...");
  const backupPath = writeBackupDump(targets);

  // Validación post-dump.
  const fs = await import("fs");
  const stats = fs.statSync(backupPath);
  if (stats.size < 100) {
    console.error(`[cleanup] backup file demasiado chico (${stats.size}B). Aborto.`);
    process.exit(1);
  }

  // 3. UPDATE en transacción para evitar drift entre select y update.
  console.log("\n[cleanup] Ejecutando UPDATE en transacción...");
  const updateResult = await prisma.$transaction(async (tx) => {
    // Re-COUNT dentro de la TX (snapshot consistente).
    const countTx = await tx.catalogProduct.count({ where: cleanupWhere });
    if (countTx !== targets.length) {
      throw new Error(
        `[cleanup] count mismatch: SELECT inicial ${targets.length} vs TX count ${countTx}. ` +
        `Algo cambió. Aborto sin escribir.`
      );
    }
    // UPDATE: finalPrice -> null SOLO. No tocamos otros campos.
    const upd = await tx.catalogProduct.updateMany({
      where: cleanupWhere,
      data: { finalPrice: null },
    });
    return upd.count;
  });
  console.log(`[cleanup] UPDATE devolvió: ${updateResult} filas modificadas.`);

  if (updateResult !== targets.length) {
    console.error(
      `[cleanup] ⚠ UPDATE count (${updateResult}) != SELECT inicial (${targets.length}). ` +
      `Backup en ${backupPath}. Investigar.`
    );
    process.exit(1);
  }

  // 4. RE-SELECT: debe dar 0.
  console.log("\n[cleanup] Re-corriendo SELECT post-UPDATE (esperado: 0)...");
  const after = await selectTargets();
  if (after.length === 0) {
    console.log("[cleanup] ✓ 0 cps quedaron en el WHERE. Limpieza cerrada.");
  } else {
    console.error(
      `[cleanup] ⚠ Quedaron ${after.length} cps matcheando el WHERE post-UPDATE. ` +
      `Algo no cuadra. Backup en ${backupPath}.`
    );
    printSummary(after, "RESIDUALES");
    process.exit(1);
  }

  console.log("\n══════════════════════════════════════════════════════════════");
  console.log("  CLEANUP COMPLETADO");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(`  cps modificados: ${updateResult}`);
  console.log(`  backup: ${backupPath}`);
  console.log(`  próximo paso: correr scripts/backfill-stale-drift.ts --dry`);
  console.log(`  para ver el bucket A recalculado (esperado ~260 publicaciones).`);
}

main()
  .catch((e) => { console.error("[cleanup] ERROR:", e); process.exit(1); })
  .finally(() => prisma.$disconnect());
