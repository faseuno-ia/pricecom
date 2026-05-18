// One-off script: limpia el campo `stock` en CatalogProduct para todos los
// productos que tienen un valor que en realidad es texto de un CTA, un label
// de form de compra ("Cantidad"), o un nombre de producto en mayúsculas que
// el scraper viejo capturó por error.
//
// Mismo criterio que cleanStockText() en lib/scraper/scraper.service.ts.
//
// Uso: npm run catalog:clean-stock

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

const VALID_STOCK_PATTERN =
  /^(sin\s+stock|disponible|agotado|en\s+stock|\d+\s*(u|ud|uds|unid|unidades?)?)$/i;

function isInvalidStock(value: string | null): boolean {
  if (!value) return false;
  const cleaned = value.trim();
  if (!cleaned) return false;
  if (/agregar|carrito|comprar|ver\s*carrito|cantidad/i.test(cleaned)) return true;
  if (cleaned.length > 50) return true;
  // Parece nombre de producto: dos o más palabras en MAYÚSCULAS consecutivas
  // (ej "CABLE USB", "MELECH 232"), salvo que sea un valor de stock válido.
  if (/[A-Z]{2,}\s+[A-Z]{2,}/.test(cleaned) && !VALID_STOCK_PATTERN.test(cleaned)) {
    return true;
  }
  return false;
}

async function main() {
  const products = await prisma.catalogProduct.findMany({
    where: { stock: { not: null } },
    select: { id: true, stock: true },
  });

  console.log(`Productos con stock: ${products.length}`);

  const toClean = products.filter((p) => isInvalidStock(p.stock));
  console.log(`Stocks inválidos a limpiar: ${toClean.length}`);

  if (toClean.length === 0) {
    console.log("Nada que limpiar.");
    return;
  }

  console.log("\nMuestra (primeros 10):");
  toClean.slice(0, 10).forEach((p) => console.log(`  - "${p.stock}"`));

  // Batch en chunks de 500 para no enviar un IN gigantesco.
  const ids = toClean.map((p) => p.id);
  const BATCH = 500;
  let total = 0;
  for (let i = 0; i < ids.length; i += BATCH) {
    const chunk = ids.slice(i, i + BATCH);
    const result = await prisma.catalogProduct.updateMany({
      where: { id: { in: chunk } },
      data: { stock: null },
    });
    total += result.count;
  }

  console.log(`\n✓ Limpiados: ${total} productos`);
}

main()
  .catch((err) => {
    console.error("Error:", err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
