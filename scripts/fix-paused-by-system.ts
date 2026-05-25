// Backfill: marcar pausedBySystem=true en los productos que el sistema pausó
// automáticamente antes de que existiera el campo.
//
// Heurística — exactamente la condición que el worker usa para auto-pausar:
//   internalStatus = PAUSED
//   supplierStatus = SUPPLIER_REMOVED
//   stockSource    = SUPPLIER
//
// Cualquier otra combinación (p.ej. PAUSED + supplier ACTIVE) es pausa manual
// y queda con pausedBySystem=false (default).

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const APPLY = process.argv.includes("--apply");

async function main() {
  console.log(APPLY ? "MODO: APLICAR" : "MODO: DRY-RUN — usar --apply para escribir\n");

  const candidates = await prisma.catalogProduct.findMany({
    where: {
      internalStatus: "PAUSED",
      supplierStatus: "SUPPLIER_REMOVED",
      stockSource: "SUPPLIER",
      pausedBySystem: false,
    },
    select: {
      id: true,
      sku: true,
      supplierName: true,
      provider: { select: { name: true } },
    },
    orderBy: [{ provider: { name: "asc" } }, { sku: "asc" }],
  });

  console.log(`Candidatos: ${candidates.length}`);
  if (candidates.length === 0) {
    console.log("Nada que backfillear.");
    return;
  }

  // Sample para confirmar visualmente.
  const SAMPLE = 10;
  console.log(`\nSample (${Math.min(SAMPLE, candidates.length)}):`);
  for (const c of candidates.slice(0, SAMPLE)) {
    console.log(
      `  · ${c.provider.name.padEnd(12)} ${c.sku ?? "(sin sku)"} — ${c.supplierName.slice(0, 50)}`
    );
  }

  if (!APPLY) {
    console.log(`\n→ Dry-run: marcaría pausedBySystem=true en ${candidates.length} productos.`);
    return;
  }

  const res = await prisma.catalogProduct.updateMany({
    where: { id: { in: candidates.map((c) => c.id) } },
    data: { pausedBySystem: true },
  });
  console.log(`\n✓ Actualizados: ${res.count}`);
}

main()
  .catch((e) => {
    console.error("ERROR:", e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
