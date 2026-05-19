import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import { CatalogTable } from "@/components/catalog/catalog-table";

export const metadata = {
  title: "Catálogo — PricEcom",
};

type SourceType = "SCRAPED" | "MANUAL" | "IMPORTED";
const VALID_SOURCE: SourceType[] = ["SCRAPED", "MANUAL", "IMPORTED"];

type StockSource = "SUPPLIER" | "OWN" | "HYBRID";
const VALID_STOCK_SOURCE: StockSource[] = ["SUPPLIER", "OWN", "HYBRID"];

type SupplierStatus = "ACTIVE" | "SUPPLIER_REMOVED";
const VALID_SUPPLIER: SupplierStatus[] = ["ACTIVE", "SUPPLIER_REMOVED"];

export default async function CatalogPage({
  searchParams,
}: {
  searchParams: {
    providerId?: string;
    sourceType?: string;
    stockSource?: string;
    supplierStatus?: string;
  };
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

  const initialStockSource =
    searchParams.stockSource &&
    VALID_STOCK_SOURCE.includes(searchParams.stockSource as StockSource)
      ? (searchParams.stockSource as StockSource)
      : null;

  const initialSupplierStatus =
    searchParams.supplierStatus &&
    VALID_SUPPLIER.includes(searchParams.supplierStatus as SupplierStatus)
      ? (searchParams.supplierStatus as SupplierStatus)
      : null;

  return (
    <CatalogTable
      providers={providers}
      initialProviderId={searchParams.providerId ?? null}
      initialSourceType={initialSourceType}
      initialStockSource={initialStockSource}
      initialSupplierStatus={initialSupplierStatus}
    />
  );
}
