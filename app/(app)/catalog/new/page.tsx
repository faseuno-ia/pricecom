import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { ManualProductForm } from "@/components/catalog/manual-product-form";

export const metadata = {
  title: "Agregar producto — PricEcom",
};

export default async function NewCatalogProductPage({
  searchParams,
}: {
  searchParams: { providerId?: string };
}) {
  const session = await requireSession();

  const [providers, categories] = await Promise.all([
    prisma.provider.findMany({
      where: { userId: session.user.id, isActive: true },
      orderBy: [{ providerType: "asc" }, { name: "asc" }],
      select: {
        id: true,
        name: true,
        providerType: true,
        scraperConfig: { select: { imageFilenamePrefix: true } },
      },
    }),
    prisma.category.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Link
          href="/catalog"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-3 w-fit"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Volver al catálogo
        </Link>
        <h1 className="text-2xl font-semibold">Agregar producto manual</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Alta one-off de un producto en el catálogo. Quedará marcado como{" "}
          <span className="text-violet-300 font-medium">Manual</span>.
        </p>
      </div>

      <div className="bg-card border border-border rounded-xl p-6">
        <ManualProductForm
          providers={providers.map((p) => ({
            id: p.id,
            name: p.name,
            providerType: p.providerType,
            prefix: p.scraperConfig?.imageFilenamePrefix ?? null,
          }))}
          categories={categories}
          initialProviderId={searchParams.providerId ?? null}
        />
      </div>
    </div>
  );
}
