import { PrismaClient } from "@prisma/client";
import { compareWithPreviousExtraction } from "../lib/comparison/compare-extractions";

const prisma = new PrismaClient();

async function main() {
  // Buscar todos los jobs COMPLETED que no tienen comparison
  const jobsWithoutComparison = await prisma.extractionJob.findMany({
    where: {
      status: "COMPLETED",
      comparison: null,
    },
    orderBy: { createdAt: "asc" }, // cronológico para que cada comparación encuentre la anterior correcta
    select: { id: true, providerId: true, createdAt: true },
  });

  console.log(`Jobs sin comparación: ${jobsWithoutComparison.length}`);

  let ok = 0,
    errors = 0;
  for (const job of jobsWithoutComparison) {
    try {
      await compareWithPreviousExtraction(job.id, prisma);
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
  .catch(console.error)
  .finally(() => prisma.$disconnect());
