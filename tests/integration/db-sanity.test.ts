// Test trivial integration: crear → leer → assertear → limpiar un
// CatalogProduct contra el branch de Neon de test. Sin lógica de negocio,
// solo valida que:
//   - el guard de env corrió sin abortar contra prod,
//   - el cliente Prisma está conectado al branch de test,
//   - el schema está aplicado en ese branch (FKs a User y Provider funcionan),
//   - el TRUNCATE CASCADE deja la DB limpia entre tests.
//
// IMPORTANTE: el import de "../setup/env" tiene que ser la PRIMERA línea — su
// side-effect carga .env.test, corre el guard y pisa process.env.DATABASE_URL
// con la URL del branch test ANTES de que cualquier otro módulo importe el
// cliente Prisma.

import "../setup/env";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { testPrisma, truncateAll } from "../setup/db";

describe("DB sanity: branch de test responde y el aislamiento funciona", () => {
  beforeEach(async () => {
    await truncateAll();
  });

  afterAll(async () => {
    await testPrisma.$disconnect();
  });

  it("crea un CatalogProduct, lo lee, y verifica los campos", async () => {
    // CatalogProduct tiene FK a User + Provider, así que sembramos los dos.
    const user = await testPrisma.user.create({
      data: {
        email: `sanity-${Date.now()}@example.com`,
        password: "hash-placeholder",
      },
    });
    const provider = await testPrisma.provider.create({
      data: {
        userId: user.id,
        name: "TEST_PROVIDER",
        providerType: "MANUAL",
        baseUrl: "https://example.test",
      },
    });
    const cp = await testPrisma.catalogProduct.create({
      data: {
        userId: user.id,
        providerId: provider.id,
        sku: "SANITY-001",
        supplierName: "Producto de prueba sanity",
        sourceType: "MANUAL",
        lastSeenAt: new Date(),
      },
    });

    expect(cp.id).toBeTruthy();
    expect(cp.sku).toBe("SANITY-001");

    const fetched = await testPrisma.catalogProduct.findUnique({
      where: { id: cp.id },
    });
    expect(fetched).not.toBeNull();
    expect(fetched?.supplierName).toBe("Producto de prueba sanity");
    expect(fetched?.internalStatus).toBe("NOT_PUBLISHED");
  });

  it("el TRUNCATE en beforeEach deja la DB sin filas residuales del test anterior", async () => {
    const count = await testPrisma.catalogProduct.count();
    expect(count).toBe(0);

    const userCount = await testPrisma.user.count();
    expect(userCount).toBe(0);
  });
});
