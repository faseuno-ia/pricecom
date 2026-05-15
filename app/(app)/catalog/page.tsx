import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { CatalogTable } from "@/components/catalog/catalog-table";

export const metadata = {
  title: "Catálogo — PricEcom",
};

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: { providerId?: string };
}) {
  const session = await requireSession();

  const providers = await prisma.provider.findMany({
    where: { userId: session.user.id },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  return (
    <CatalogTable
      providers={providers}
      initialProviderId={searchParams.providerId ?? null}
    />
  );
}
