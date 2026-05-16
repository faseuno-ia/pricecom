import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { PricingRulesPage } from "@/components/pricing/pricing-rules-page";

export const metadata = {
  title: "Pricing — PricEcom",
};

export default async function Page() {
  const session = await requireSession();

  const [providers, categories] = await Promise.all([
    prisma.provider.findMany({
      where: { userId: session.user.id },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.category.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
  ]);

  return <PricingRulesPage providers={providers} categories={categories} />;
}
