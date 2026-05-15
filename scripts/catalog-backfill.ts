import { PrismaClient } from "@prisma/client";
import { upsertCatalogProducts } from "../lib/catalog/upsert-catalog-products";

const prisma = new PrismaClient();

async function main() {
  const jobs = await prisma.extractionJob.findMany({
    where: { status: "COMPLETED" },
    orderBy: { createdAt: "asc" },
    select: { id: true, providerId: true, createdAt: true },
  });

  console.log(`Jobs a procesar: ${jobs.length}`);
  let ok = 0;
  let errors = 0;

  for (const job of jobs) {
    try {
      await upsertCatalogProducts(job.id, prisma);
      console.log(`✓ ${job.id} (${job.createdAt.toISOString().slice(0, 10)})`);
      ok++;
    } catch (err) {
      console.error(`✗ ${job.id}:`, err);
      errors++;
    }
  }

  console.log(`\nCompletado: ${ok} ok, ${errors} errores`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
