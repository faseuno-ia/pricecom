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

  // Server-side: solo cargamos la lista de proveedores para el dropdown de
  // filtros. El resto (cambios + paginación + filtros activos) lo maneja el
  // ChangesTable consumiendo /api/changes via fetch.
  const providers = await prisma.provider.findMany({
    where: { userId: session.user.id },
    orderBy: { name: "asc" },
    select: { id: true, name: true },
  });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Cambios</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Inteligencia comercial cross-proveedor: precios, stock, productos
          nuevos y removidos
        </p>
      </div>

      <ChangesTable
        providers={providers}
        initialProviderId={searchParams.providerId ?? null}
      />
    </div>
  );
}
