import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { CatalogTable } from "@/components/catalog/catalog-table";

export const metadata = {
  title: "Catálogo — PricEcom",
};

type SourceType = "SCRAPED" | "MANUAL" | "IMPORTED";
const VALID_SOURCE: SourceType[] = ["SCRAPED", "MANUAL", "IMPORTED"];

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: { providerId?: string; sourceType?: string };
}) {
  const session = await requireSession();

  const providers = await prisma.provider.findMany({
    where: { userId: session.user.id },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  const initialSourceType =
    searchParams.sourceType && VALID_SOURCE.includes(searchParams.sourceType as SourceType)
      ? (searchParams.sourceType as SourceType)
      : null;

  return (
    <CatalogTable
      providers={providers}
      initialProviderId={searchParams.providerId ?? null}
      initialSourceType={initialSourceType}
    />
  );
}
