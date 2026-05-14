import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

async function main() {
  const job = await prisma.extractionJob.findFirst({
    orderBy: { createdAt: 'desc' },
    include: { provider: { select: { name: true } } },
  })

  if (!job) {
    console.log('No hay ExtractionJob en la DB.')
    return
  }

  console.log('=== Último ExtractionJob ===')
  console.log('id:           ', job.id)
  console.log('provider:     ', job.provider.name)
  console.log('status:       ', job.status)
  console.log('createdAt:    ', job.createdAt.toISOString())
  console.log('finishedAt:   ', job.finishedAt?.toISOString() ?? '(null)')
  console.log('totalProducts:', job.totalProducts)

  const total = await prisma.extractedProduct.count({ where: { jobId: job.id } })
  const withImg = await prisma.extractedProduct.count({
    where: { jobId: job.id, imageUrl: { not: null } },
  })
  const nullImg = total - withImg
  // Dos filtros sobre el mismo campo: combinar via AND (un solo objeto no puede
  // repetir la key `not`). Filtra imageUrl que no sea null Y no sea string vacío.
  const withImgNotEmpty = await prisma.extractedProduct.count({
    where: {
      jobId: job.id,
      AND: [{ imageUrl: { not: null } }, { imageUrl: { not: '' } }],
    },
  })

  console.log('\n=== ExtractedProduct.imageUrl ===')
  console.log('total productos:        ', total)
  console.log('con imageUrl != null:   ', withImg)
  console.log('con imageUrl null:      ', nullImg)
  console.log('con imageUrl no vacío:  ', withImgNotEmpty)

  const samples = await prisma.extractedProduct.findMany({
    where: { jobId: job.id },
    select: { sku: true, name: true, imageUrl: true },
    take: 5,
  })
  console.log('\n=== Muestra (primeros 5) ===')
  for (const p of samples) {
    console.log(`- [${p.sku ?? '-'}] ${p.name?.slice(0, 50)} | imageUrl: ${p.imageUrl ?? '(null)'}`)
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
