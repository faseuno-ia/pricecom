import { prisma } from "@/lib/db/client";
import { NewExtractionForm } from "@/components/extractions/new-extraction-form";

export default async function NewExtractionPage() {
  const providers = await prisma.provider.findMany({
    where: { isActive: true },
    orderBy: { name: "asc" },
    select: { id: true, name: true, baseUrl: true },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Nueva extracción</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Seleccioná un proveedor y comenzá la extracción de productos
        </p>
      </div>
      <NewExtractionForm providers={providers} />
    </div>
  );
}
