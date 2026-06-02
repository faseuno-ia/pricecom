import { defineConfig } from "vitest/config";
import tsconfigPaths from "vite-tsconfig-paths";

// Config único para unit + integration. La diferencia se hace por `--dir` en
// los scripts de package.json:
//   test:unit  → tests/unit (sin DB, sin .env.test, rápido)
//   test:int   → tests/integration (cada archivo importa tests/setup/env.ts en
//                la primera línea para cargar .env.test + correr el guard
//                ANTES de que cualquier módulo importe el cliente Prisma)
//
// Tsconfig paths habilita el alias "@/..." que usa el resto del codebase para
// que los tests puedan importar tal cual.
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: false,
    testTimeout: 30_000,
  },
});
