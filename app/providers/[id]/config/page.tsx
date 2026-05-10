import { prisma } from "@/lib/db/client";
import { notFound } from "next/navigation";
import { ScraperConfigForm } from "@/components/providers/scraper-config-form";

export default async function ConfigPage({ params }: { params: { id: string } }) {
  const provider = await prisma.provider.findUnique({
    where: { id: params.id },
    include: { scraperConfig: true },
  });
  if (!provider) notFound();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Configurar selectores</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {provider.name} — Selectores CSS para extracción
        </p>
      </div>
      <div className="bg-card border rounded-xl p-6">
        <ScraperConfigForm providerId={params.id} config={provider.scraperConfig} />
      </div>
    </div>
  );
}
