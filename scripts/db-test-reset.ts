// Reset destructivo del branch de Neon "test": prisma db push --force-reset.
// El schema se toma de schema.prisma (no del historial de migraciones).
//
// Por qué db push y no migrate deploy: el historial de migraciones del repo
// no reconstruye el schema real de prod (el init es un esqueleto histórico,
// faltan ~15 tablas y casi todos los enums; prod se construyó originalmente
// con db push masivo). Reconstruir el init es deuda separada — ver
// docs/known-debts.md "Migration history no reconstruye el schema de prod".
//
// Para los tests es suficientemente fiel: el código importa Prisma Client
// que se genera de schema.prisma, así que testear contra el schema que sale
// de schema.prisma es testear contra el schema que el código realmente asume.
// La fidelidad que perdemos es la del historial de migraciones — la deuda
// arriba la cubre, no este script.
//
// Usa el mismo guard que tests/setup/env.ts — imposible correr contra prod
// por accidente.

import "../tests/setup/env";
import { spawnSync } from "node:child_process";

async function main() {
  const host = process.env.DATABASE_URL?.match(/@([^/]+)/)?.[1] ?? "<host?>";
  console.log(
    `[db-test-reset] Reset destructivo del branch ${host}\n` +
      `[db-test-reset] (schema desde prisma/schema.prisma vía db push --force-reset)\n`
  );

  // --force-reset:    dropea TODO y recrea desde cero.
  // --skip-generate:  no regenera Prisma Client (ya está generado para prod).
  // --accept-data-loss: confirma que sabemos que se pierde la data del branch.
  const result = spawnSync(
    "npx",
    [
      "prisma",
      "db",
      "push",
      "--force-reset",
      "--skip-generate",
      "--accept-data-loss",
    ],
    {
      stdio: "inherit",
      env: process.env,
      shell: true,
    }
  );

  if (result.status !== 0) {
    console.error(
      `\n[db-test-reset] FALLÓ en db push con exit code ${result.status}`
    );
    process.exit(result.status ?? 1);
  }

  console.log(
    `\n[db-test-reset] ✓ Branch de test listo (schema = schema.prisma)`
  );
}

main().catch((err) => {
  console.error("[db-test-reset] ERROR:", err);
  process.exit(1);
});
