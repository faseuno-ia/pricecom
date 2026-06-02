// Helpers de DB para tests de integración. Asume que tests/setup/env.ts ya
// corrió (carga .env.test + pisa process.env.DATABASE_URL con la URL del
// branch test). Importar SIEMPRE después de env.ts:
//
//   import "../setup/env";
//   import { testPrisma, truncateAll } from "../setup/db";

import { PrismaClient } from "@prisma/client";

// Cliente Prisma dedicado a tests. Se inicializa con la URL del branch de
// test explícitamente (defensa por si alguien cambia process.env entre tests)
// y se mantiene separado del singleton de lib/db/client.ts para que el
// truncate operé sobre la conexión correcta.
export const testPrisma = new PrismaClient({
  datasources: {
    db: { url: process.env.DATABASE_URL_TEST },
  },
  log: ["error"],
});

/**
 * Limpia todas las tablas de usuario en la DB de test.
 *
 * Implementación: TRUNCATE ... RESTART IDENTITY CASCADE sobre todas las tablas
 * del schema "public" excepto la de migraciones de Prisma. CASCADE resuelve
 * automáticamente el orden de las foreign keys, así que no hay que mantener
 * una lista ordenada de tablas.
 *
 * Velocidad: ~50ms en una DB chica como la nuestra. Ejecutar en beforeEach()
 * de cada describe de integración para garantizar aislamiento total entre
 * tests.
 */
export async function truncateAll(): Promise<void> {
  const tables = await testPrisma.$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables
    WHERE schemaname = 'public'
      AND tablename != '_prisma_migrations'
  `;

  if (tables.length === 0) return;

  const tableList = tables.map((t) => `"public"."${t.tablename}"`).join(", ");
  // $executeRawUnsafe porque la lista de tablas se construye dinámicamente
  // (no se puede parametrizar identifiers). Las tablas vienen de pg_tables del
  // schema test — no son input externo.
  await testPrisma.$executeRawUnsafe(
    `TRUNCATE TABLE ${tableList} RESTART IDENTITY CASCADE`
  );
}
