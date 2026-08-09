// 2G-R8-Q2.1-B · §3 — RESTORE del estado comercial pre-run. DRY_RUN POR DEFECTO. FAIL-CLOSED.
//
// Semántica: COMMERCIAL_STATE_RESTORE_NOT_HISTORY_ERASURE. Revierte SÓLO los campos mutados por
// Q2.1-B (wholesalePrice, lastSeenAt, latestExtractedProductId) de las filas que la corrida escribió,
// y SÓLO si su estado actual todavía coincide con el estado que la corrida produjo (buildRestorePlan).
// Cualquier conflicto (una fila cambió después por otra operación) → aborta ANTES de escribir. NO borra
// ExtractionJob/EventLog/ExtractedProduct/witnesses. Ejecución real requiere --apply Y coincidencia de
// SHAs esperados (guard de identidad §3.2).
//
//   DT_ENV_FILE=/ruta/.env npx tsx scripts/dt-q21b-restore.ts \
//     --pre=pre.json --post=post.json --expectedProviderId=<id> --expectedPreSha=<sha> [--apply]
import { readFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { buildRestorePlan, type RestoreMutableRow } from "../lib/catalog/restore-guard";

const ENV_FILE = process.env.DT_ENV_FILE;
if (!ENV_FILE) { console.error("Falta DT_ENV_FILE."); process.exit(2); }
const arg = (n: string) => { const a = process.argv.find((x) => x.startsWith(`--${n}=`)); return a ? a.split("=").slice(1).join("=") : null; };
const APPLY = process.argv.includes("--apply");
const PRE = arg("pre"), POST = arg("post"), EXPECTED_PROVIDER = arg("expectedProviderId"), EXPECTED_PRE_SHA = arg("expectedPreSha");
if (!PRE || !POST || !EXPECTED_PROVIDER || !EXPECTED_PRE_SHA) {
  console.error("Requeridos: --pre --post --expectedProviderId --expectedPreSha. --apply para ejecutar (default DRY_RUN).");
  process.exit(2);
}
function loadEnv(p: string) { const o: any = {}; for (const l of readFileSync(p, "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/); if (m) o[m[1]] = m[2].replace(/^["']|["']$/g, "").trim(); } return o; }
const mutable = (r: any): RestoreMutableRow => ({ id: r.id, sku: r.sku, wholesalePrice: r.wholesalePrice == null ? null : Number(r.wholesalePrice), lastSeenAt: r.lastSeenAt ?? null, latestExtractedProductId: r.latestExtractedProductId ?? null });
const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function main() {
  const env = loadEnv(ENV_FILE!);
  const pre = JSON.parse(readFileSync(PRE!, "utf8"));
  const post = JSON.parse(readFileSync(POST!, "utf8"));
  // §3.2 · guard de identidad: el snapshot pre debe coincidir con lo esperado.
  if (pre.providerId !== EXPECTED_PROVIDER) { console.error(`STOP: pre.providerId ${pre.providerId} != esperado ${EXPECTED_PROVIDER}`); process.exit(3); }
  if (pre.snapshotSha256 !== EXPECTED_PRE_SHA) { console.error(`STOP: pre.snapshotSha256 no coincide con --expectedPreSha`); process.exit(3); }

  // El universo mutado = filas cuyo (wholesalePrice|lastSeenAt|latestExtractedProductId) difiere entre pre y post.
  const preById = new Map<string, any>(pre.rows.map((r: any) => [r.id, r]));
  const expectedPost: RestoreMutableRow[] = post.rows
    .map(mutable)
    .filter((pr: RestoreMutableRow) => { const b = preById.get(pr.id); return b && (Number(b.wholesalePrice ?? NaN) !== (pr.wholesalePrice ?? NaN) || (b.lastSeenAt ?? null) !== pr.lastSeenAt || (b.latestExtractedProductId ?? null) !== pr.latestExtractedProductId); });

  const prisma = new PrismaClient({ datasources: { db: { url: env.DIRECT_URL } } });
  try {
    const currentRows = await prisma.catalogProduct.findMany({
      where: { providerId: EXPECTED_PROVIDER!, id: { in: expectedPost.map((r) => r.id) } },
      select: { id: true, sku: true, wholesalePrice: true, lastSeenAt: true, latestExtractedProductId: true },
    });
    const current: RestoreMutableRow[] = currentRows.map((r) => ({ id: r.id, sku: r.sku, wholesalePrice: r.wholesalePrice == null ? null : Number(r.wholesalePrice), lastSeenAt: iso(r.lastSeenAt), latestExtractedProductId: r.latestExtractedProductId }));
    const preRun: RestoreMutableRow[] = pre.rows.map(mutable);

    const plan = buildRestorePlan({ preRun, expectedPost, current });
    console.log(`MODE=${APPLY ? "APPLY" : "DRY_RUN"}`);
    console.log(`rowsEvaluated=${plan.rowsEvaluated} rowsWouldRestore=${plan.rowsWouldRestore} rowsAlreadyMatchingPreRun=${plan.rowsAlreadyMatchingPreRun}`);
    console.log(`conflicts=${plan.conflictCount} fieldDiffCounts=${JSON.stringify(plan.fieldDiffCounts)} safe=${plan.safe}`);
    if (plan.conflictCount > 0) console.log(`CONFLICT_SAMPLE=${JSON.stringify(plan.conflicts.slice(0, 20).map((c) => ({ id: c.id, sku: c.sku })))}`);

    if (!plan.safe) { console.log("RESTORE_ABORTED=CONFLICT_FAIL_CLOSED (cero escritura)"); process.exit(4); }
    if (!APPLY) { console.log("DRY_RUN: no se escribió nada. Re-ejecutar con --apply para restaurar."); return; }

    // APPLY: escribe el plan (fila por fila). Sólo los 3 campos mutables.
    let written = 0;
    for (const e of plan.plan) {
      await prisma.catalogProduct.update({ where: { id: e.id }, data: { wholesalePrice: e.to.wholesalePrice, lastSeenAt: e.to.lastSeenAt ? new Date(e.to.lastSeenAt) : undefined, latestExtractedProductId: e.to.latestExtractedProductId } });
      written++;
    }
    console.log(`RESTORE_APPLIED rowsRestored=${written}`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("RESTORE_ERROR", e?.message ?? e); process.exit(1); });
