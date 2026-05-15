import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { ChangesTable } from "@/components/changes/changes-table";

export const metadata = {
  title: "Cambios — PricEcom",
};

export default async function ChangesPage({
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
    <ChangesTable
      providers={providers}
      initialProviderId={searchParams.providerId ?? null}
    />
  );
}
