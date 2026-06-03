// Reset destructivo del branch de Neon "test":
//   1. DROP SCHEMA public CASCADE + CREATE SCHEMA public
//   2. prisma migrate deploy (aplica el baseline + cualquier migración futura)
//
// Post-rebaseline 2026-06-03: el historial de migraciones del repo ya
// reconstruye el schema completo de prod (un único baseline en
// prisma/migrations/20260603000000_baseline/ + las incrementales que se
// agreguen). El reset usa migrate deploy en vez de db push para mantener
// fidelidad con el historial real — si una migración nueva tiene un bug
// (DDL inválido, falta de FK), este script lo detecta antes que CI o prod.
//
// Las migraciones pre-rebaseline están archivadas en
// prisma/migrations-archive/20260603-pre-rebaseline/ (ver README ahí).
//
// Usa el mismo guard que tests/setup/env.ts — imposible correr contra prod
// por accidente.

import "../tests/setup/env";
import { spawnSync } from "node:child_process";
import { PrismaClient } from "@prisma/client";

async function main() {
  const host = process.env.DATABASE_URL?.match(/@([^/]+)/)?.[1] ?? "<host?>";
  console.log(`[db-test-reset] Reset destructivo del branch ${host}\n`);

  // PASO 1: limpieza total del schema public.
  const prisma = new PrismaClient({
    datasources: { db: { url: process.env.DIRECT_URL_TEST } },
    log: ["error"],
  });
  try {
    console.log(
      "[db-test-reset] DROP SCHEMA public CASCADE + CREATE SCHEMA public ..."
    );
    await prisma.$executeRawUnsafe("DROP SCHEMA public CASCADE");
    await prisma.$executeRawUnsafe("CREATE SCHEMA public");
    await prisma.$executeRawUnsafe("GRANT ALL ON SCHEMA public TO public");
    console.log("[db-test-reset] ✓ Schema dropeado y recreado\n");
  } finally {
    await prisma.$disconnect();
  }

  // PASO 2: aplicar el historial desde cero.
  console.log("[db-test-reset] prisma migrate deploy (aplicando historial)...\n");
  const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
    stdio: "inherit",
    env: process.env,
    shell: true,
  });

  if (result.status !== 0) {
    console.error(
      `\n[db-test-reset] FALLÓ en migrate deploy con exit code ${result.status}`
    );
    process.exit(result.status ?? 1);
  }

  console.log(
    `\n[db-test-reset] ✓ Branch de test listo (schema = migrate deploy desde cero)`
  );
}

main().catch((err) => {
  console.error("[db-test-reset] ERROR:", err);
  process.exit(1);
});
