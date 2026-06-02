// Aplica el schema de Prisma sobre el branch de Neon "test".
//
// Usa `prisma migrate deploy` (no `db push`) para que el schema en el branch
// de test sea EXACTAMENTE el que produce el historial de migraciones — el
// mismo que corre en prod. Si hay drift entre lo que el schema.prisma infiere
// y lo que las migraciones aplican, los tests deben correr contra lo segundo
// (es lo que está en prod). Fidelidad > velocidad para una regression suite.
//
// Uso: `npm run db:test:migrate`
//
// El flujo:
//   1. Importar tests/setup/env.ts (side-effect): carga .env.test + corre el
//      guard de 3 capas + pisa process.env.DATABASE_URL / DIRECT_URL con las
//      URLs del branch de test.
//   2. Spawnear `npx prisma migrate deploy` heredando process.env. Prisma lee
//      DATABASE_URL y DIRECT_URL en su CLI, así que el child process apunta
//      al branch de test, no a prod.
//
// El guard del paso 1 imposibilita que este script corra contra prod por
// accidente.

import "../tests/setup/env";
import { spawnSync } from "node:child_process";

console.log(
  `[db-test-migrate] Aplicando schema sobre el branch de Neon de test ` +
    `(${process.env.DATABASE_URL?.match(/@([^/]+)/)?.[1] ?? "<host?>"})...\n`
);

const result = spawnSync("npx", ["prisma", "migrate", "deploy"], {
  stdio: "inherit",
  env: process.env,
  shell: true, // Windows: spawn de npx requiere shell
});

if (result.status !== 0) {
  console.error(`\n[db-test-migrate] FALLÓ con exit code ${result.status}`);
  process.exit(result.status ?? 1);
}

console.log(`\n[db-test-migrate] ✓ Schema aplicado correctamente`);
