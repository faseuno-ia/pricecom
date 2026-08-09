// 2G-R8-Q2.1-B · §3.1/§10 — SNAPSHOT del catálogo DT (pre-run o post-run). READ-ONLY.
// Captura TODOS los campos que Q2.1-B puede mutar + los estables (para el diff), con orden estable y
// SHAs determinísticos (buildCatalogSnapshot). No escribe nada. Sin secretos (no imprime precios).
//
//   DT_ENV_FILE=/ruta/.env  DT_PROVIDER_ID=<id>  npx tsx scripts/dt-q21b-snapshot.ts --out=snap.json
import { readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { buildCatalogSnapshot, type CatalogSnapshotRow } from "../lib/catalog/catalog-snapshot-diff";

const ENV_FILE = process.env.DT_ENV_FILE;
const PROVIDER_ID = process.env.DT_PROVIDER_ID || "cms8554bw0002cxz7qm3buvwm";
if (!ENV_FILE) { console.error("Falta DT_ENV_FILE (ruta al .env con DIRECT_URL)."); process.exit(2); }
const outArg = process.argv.find((a) => a.startsWith("--out="));
const OUT = outArg ? outArg.split("=")[1] : `dt-q21b-snapshot-${PROVIDER_ID}.json`;

function loadEnv(p: string) { const o: any = {}; for (const l of readFileSync(p, "utf8").split(/\r?\n/)) { const m = l.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/); if (m) o[m[1]] = m[2].replace(/^["']|["']$/g, "").trim(); } return o; }
const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function main() {
  const env = loadEnv(ENV_FILE!);
  const prisma = new PrismaClient({ datasources: { db: { url: env.DIRECT_URL } } });
  try {
    const rows = await prisma.catalogProduct.findMany({
      where: { providerId: PROVIDER_ID },
      select: {
        id: true, sku: true, wholesalePrice: true, lastSeenAt: true, latestExtractedProductId: true,
        supplierName: true, supplierDescription: true, supplierCategory: true, imageUrl: true, productUrl: true,
        stock: true, supplierStatus: true, internalStatus: true, pausedBySystem: true,
      },
    });
    const snapshotRows: CatalogSnapshotRow[] = rows.map((r) => ({
      id: r.id, sku: r.sku, wholesalePrice: r.wholesalePrice == null ? null : Number(r.wholesalePrice),
      lastSeenAt: iso(r.lastSeenAt), latestExtractedProductId: r.latestExtractedProductId,
      supplierName: r.supplierName, supplierDescription: r.supplierDescription, supplierCategory: r.supplierCategory,
      imageUrl: r.imageUrl, productUrl: r.productUrl, stock: r.stock, supplierStatus: r.supplierStatus,
      internalStatus: r.internalStatus, pausedBySystem: r.pausedBySystem,
    }));
    const snap = buildCatalogSnapshot(snapshotRows);
    writeFileSync(OUT, JSON.stringify({ providerId: PROVIDER_ID, capturedAt: new Date().toISOString(), ...snap }, null, 2));
    console.log(`SNAPSHOT_WRITTEN=${OUT}`);
    console.log(`ROW_COUNT=${snap.rowCount}`);
    console.log(`SNAPSHOT_SHA256=${snap.snapshotSha256}`);
    console.log(`STABLE_FIELDS_SHA256=${snap.stableFieldsSha256}`);
    console.log(`PRICE_VECTOR_SHA256=${snap.priceVectorSha256}`);
  } finally {
    await prisma.$disconnect();
  }
}
main().catch((e) => { console.error("SNAPSHOT_ERROR", e?.message ?? e); process.exit(1); });
