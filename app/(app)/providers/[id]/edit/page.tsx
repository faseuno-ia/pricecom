import { prisma } from "@/lib/db/client";
import { notFound } from "next/navigation";
import { ProviderForm } from "@/components/providers/provider-form";
import { requireSession } from "@/lib/auth";

export default async function EditProviderPage({ params }: { params: { id: string } }) {
  const session = await requireSession();
  const provider = await prisma.provider.findFirst({
    where: { id: params.id, userId: session.user.id },
  });
  if (!provider) notFound();

  // Sample supplierSku para el preview del prefijo. Buscamos el primer producto
  // del proveedor con sku no vacío. Si no hay productos cargados todavía, el
  // ProviderForm usa un placeholder.
  const sampleProduct = await prisma.catalogProduct.findFirst({
    where: {
      providerId: provider.id,
      userId: session.user.id,
      sku: { not: null },
    },
    select: { sku: true },
    orderBy: { createdAt: "asc" },
  });

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
            providerType: provider.providerType,
            baseUrl: provider.baseUrl,
            requiresLogin: provider.requiresLogin,
            username: provider.username,
            isActive: provider.isActive,
            notes: provider.notes,
            listDiscountPercent: provider.listDiscountPercent
              ? Number(provider.listDiscountPercent)
              : 0,
            skuPrefix: provider.skuPrefix ?? "",
          }}
          sampleSupplierSku={sampleProduct?.sku ?? null}
        />
      </div>
    </div>
  );
}
