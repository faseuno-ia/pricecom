// READ-ONLY. Dump de _prisma_migrations contra PROD (DATABASE_URL de .env, NO
// .env.test). Rollback point del rebaseline 2026-06-03:
//   - Imprime las filas en pantalla.
//   - Guarda JSON completo en backups/prisma-migrations-pre-rebaseline-<ts>.json.
//
// Para reconstruir el estado original si todo se rompe: usar el JSON para hacer
// los INSERT correspondientes en _prisma_migrations.
//
// Guard: aborta si DATABASE_URL no apunta al endpoint de prod. Defensivo, para
// no dumpear el test branch por error.

import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

// Carga .env (NO .env.test). Sin .env, prisma cliente no puede conectarse.
dotenv.config({ path: ".env" });

const PROD_ENDPOINT_ID = "ep-raspy-cloud-ap9iuixg";

if (!process.env.DATABASE_URL) {
  console.error("[dump] DATABASE_URL no está definida. Falta .env.");
  process.exit(1);
}
if (!process.env.DATABASE_URL.includes(PROD_ENDPOINT_ID)) {
  console.error(
    `[dump] DATABASE_URL NO contiene el endpoint de prod (${PROD_ENDPOINT_ID}). ` +
      `Este script es solo para dumpear prod. Aborta.`
  );
  process.exit(1);
}

import { PrismaClient } from "@prisma/client";

interface MigrationRow {
  id: string;
  checksum: string;
  finished_at: Date | null;
  migration_name: string;
  logs: string | null;
  rolled_back_at: Date | null;
  started_at: Date;
  applied_steps_count: number;
}

async function main() {
  const prisma = new PrismaClient();

  console.log("══════════════════════════════════════════════════════════════");
  console.log("  Dump de _prisma_migrations contra PROD");
  console.log("══════════════════════════════════════════════════════════════");
  console.log(
    `  Endpoint: ${process.env.DATABASE_URL?.match(/@([^/]+)/)?.[1] ?? "<?>"}`
  );
  console.log("");

  try {
    const rows = await prisma.$queryRawUnsafe<MigrationRow[]>(
      `SELECT id, checksum, finished_at, migration_name, logs,
              rolled_back_at, started_at, applied_steps_count
       FROM _prisma_migrations
       ORDER BY started_at ASC`
    );

    console.log(`Total filas: ${rows.length}\n`);

    // Tabla legible en pantalla.
    console.log(
      "  # | migration_name                                    | checksum (short)    | finished_at         | rolled_back_at"
    );
    console.log(
      "  --+---------------------------------------------------+---------------------+---------------------+---------------------"
    );
    rows.forEach((r, idx) => {
      const num = String(idx + 1).padStart(2, " ");
      const name = r.migration_name.padEnd(49, " ").slice(0, 49);
      const checksumShort = r.checksum.slice(0, 16) + "…";
      const finished = r.finished_at
        ? r.finished_at.toISOString().slice(0, 19)
        : "null".padEnd(19);
      const rolled = r.rolled_back_at
        ? r.rolled_back_at.toISOString().slice(0, 19)
        : "null";
      console.log(`  ${num} | ${name} | ${checksumShort.padEnd(19)} | ${finished} | ${rolled}`);
    });
    console.log("");

    // Guardar JSON. La serialización maneja Date → ISO string vía replacer.
    const tsLabel = new Date()
      .toISOString()
      .replace(/[:.]/g, "-")
      .slice(0, 19);
    const outDir = "backups";
    fs.mkdirSync(outDir, { recursive: true });
    const outPath = path.join(outDir, `prisma-migrations-pre-rebaseline-${tsLabel}.json`);
    fs.writeFileSync(
      outPath,
      JSON.stringify(
        rows,
        (_k, v) => (v instanceof Date ? v.toISOString() : v),
        2
      )
    );
    const sizeKb = (fs.statSync(outPath).size / 1024).toFixed(2);
    console.log(`✓ JSON guardado en: ${outPath}`);
    console.log(`  Tamaño: ${sizeKb} KB · Filas: ${rows.length}`);
    console.log(`  Estado en disco: ${fs.existsSync(outPath) ? "OK" : "ERROR"}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("[dump] ERROR:", e);
  process.exit(1);
});
