import { prisma } from "@/lib/db/client";
import { notFound } from "next/navigation";
import { ProviderForm } from "@/components/providers/provider-form";

export default async function EditProviderPage({ params }: { params: { id: string } }) {
  const provider = await prisma.provider.findUnique({ where: { id: params.id } });
  if (!provider) notFound();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Editar proveedor</h1>
        <p className="text-muted-foreground mt-1 text-sm">{provider.name}</p>
      </div>
      <div className="bg-card border rounded-xl p-6">
        <ProviderForm
          provider={{
            id: provider.id,
            name: provider.name,
            baseUrl: provider.baseUrl,
            requiresLogin: provider.requiresLogin,
            username: provider.username,
            isActive: provider.isActive,
            notes: provider.notes,
          }}
        />
      </div>
    </div>
  );
}
