// Setup de entorno para tests de integración. Importar en la PRIMERA línea de
// cada test que toque la DB:
//
//   import "../setup/env";  // side-effect: carga .env.test + corre el guard
//   import { testPrisma } from "../setup/db";
//
// El módulo se importa por side-effect: al evaluarse, ejecuta loadAndGuardTestEnv
// y pisa process.env.DATABASE_URL / DIRECT_URL con las URLs de test. Eso debe
// pasar ANTES de que cualquier módulo importe el cliente Prisma singleton de
// lib/db/client.ts (el singleton lee process.env.DATABASE_URL en su constructor).
//
// El mismo helper lo usa scripts/db-test-migrate.ts antes de spawnear prisma
// migrate deploy, así el guard vive en UN solo lugar.

import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

// ── ANCLA FIJA ──────────────────────────────────────────────────────────────
// Endpoint del Neon de PRODUCCIÓN. Esta constante es el ancla del guard: NO
// depende de qué variable de entorno esté cargada cuando el guard corre. Si
// algún día el proyecto migra a otro Neon, hay que actualizar acá Y cambiar
// las URLs del .env de prod. Tener una constante hardcodeada es lo que hace
// imposible apuntar a prod por accidente desde el test runner.
const PROD_ENDPOINT_ID = "ep-raspy-cloud-ap9iuixg";

let alreadyRan = false;

export function loadAndGuardTestEnv() {
  if (alreadyRan) return;
  alreadyRan = true;

  // 1. Cargar .env.test (NO debe estar commiteado — gitignored).
  const envPath = path.resolve(process.cwd(), ".env.test");
  if (!fs.existsSync(envPath)) {
    throw new Error(
      `[test-env-guard] .env.test no encontrado en ${envPath}.\n` +
        `Crear el archivo con DATABASE_URL_TEST, DIRECT_URL_TEST y ` +
        `TEST_DB_CONFIRMED=true (ver .env.test.example).`
    );
  }
  dotenv.config({ path: envPath });

  const testUrl = process.env.DATABASE_URL_TEST;
  const directTestUrl = process.env.DIRECT_URL_TEST;
  const confirmed = process.env.TEST_DB_CONFIRMED;

  // 2. Existencia. Las dos URLs son obligatorias — migrate deploy usa la direct.
  if (!testUrl) {
    throw new Error(
      "[test-env-guard] DATABASE_URL_TEST no está definida en .env.test"
    );
  }
  if (!directTestUrl) {
    throw new Error(
      "[test-env-guard] DIRECT_URL_TEST no está definida en .env.test"
    );
  }

  // 3. Guard negativo: NINGUNA URL puede contener el endpoint de prod. Esta
  // es la capa crítica: ancla contra una constante fija, no contra otra env
  // var que puede estar pisada.
  if (testUrl.includes(PROD_ENDPOINT_ID)) {
    throw new Error(
      `🛑 [test-env-guard] ABORT: DATABASE_URL_TEST contiene el endpoint de ` +
        `PRODUCCIÓN ("${PROD_ENDPOINT_ID}"). Los tests truncan tablas — ` +
        `apuntar a prod sería catastrófico. Verificá .env.test.`
    );
  }
  if (directTestUrl.includes(PROD_ENDPOINT_ID)) {
    throw new Error(
      `🛑 [test-env-guard] ABORT: DIRECT_URL_TEST contiene el endpoint de ` +
        `PRODUCCIÓN ("${PROD_ENDPOINT_ID}"). Verificá .env.test.`
    );
  }

  // 4. Guard positivo (Opción B): confirmación humana explícita. El endpoint
  // del branch de test es un nombre random asignado por Neon (no contiene
  // "test" ni similar), así que no podemos validar por substring. En su lugar
  // exigimos que el archivo .env.test declare explícitamente TEST_DB_CONFIRMED=true,
  // que es una firma humana de "sí, sé que estas URLs apuntan al branch de
  // test, no a prod". Si alguien clona el repo y deja credenciales viejas,
  // el guard aborta.
  if (confirmed !== "true") {
    throw new Error(
      `🛑 [test-env-guard] ABORT: TEST_DB_CONFIRMED debe ser exactamente ` +
        `"true" en .env.test. Esta es una confirmación humana de que las ` +
        `URLs apuntan al branch de test, no a prod. Si lo seteás, asegurate ` +
        `de haber chequeado que el endpoint sea el de la branch correcta.`
    );
  }

  // ── Pisar las env vars que lee Prisma ─────────────────────────────────────
  // Esto debe pasar ANTES de cualquier `import { prisma } from "lib/db/client"`.
  // Prisma lee DATABASE_URL en el constructor de PrismaClient, que el singleton
  // de lib/db/client.ts inicializa al primer import. Por eso este módulo se
  // importa por side-effect en la primera línea de cada test de integración.
  process.env.DATABASE_URL = testUrl;
  process.env.DIRECT_URL = directTestUrl;
}

// Side-effect on import: ejecutar el guard. Idempotente vía alreadyRan.
loadAndGuardTestEnv();
