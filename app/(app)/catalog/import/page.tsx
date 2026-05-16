import { prisma } from "@/lib/db/client";
import { requireSession } from "@/lib/auth";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { CatalogImportForm } from "@/components/catalog/catalog-import-form";

export const metadata = {
  title: "Importar catálogo — PricEcom",
};

export default async function CatalogImportPage({
  searchParams,
}: {
  searchParams: { providerId?: string };
}) {
  const session = await requireSession();

  const providers = await prisma.provider.findMany({
    where: { userId: session.user.id, isActive: true },
    orderBy: [{ providerType: "asc" }, { name: "asc" }],
    select: { id: true, name: true, providerType: true },
  });

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <Link
          href="/catalog"
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground mb-3 w-fit"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Volver al catálogo
        </Link>
        <h1 className="text-2xl font-semibold">Importar catálogo</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Subí un Excel o CSV con los productos. Se hará upsert por SKU dentro
          del proveedor elegido. Los productos quedarán marcados como{" "}
          <span className="text-amber-300 font-medium">Importado</span>.
        </p>
      </div>

      <div className="bg-card border border-border rounded-xl p-6">
        <CatalogImportForm
          providers={providers}
          initialProviderId={searchParams.providerId ?? null}
        />
      </div>

      <div className="bg-card border border-border rounded-xl p-5 text-xs text-muted-foreground space-y-2">
        <p className="font-medium text-foreground text-sm">
          Columnas esperadas del archivo
        </p>
        <ul className="list-disc pl-5 space-y-0.5">
          <li>
            <span className="text-foreground font-mono">SKU</span> (requerido)
          </li>
          <li>
            <span className="text-foreground font-mono">Nombre</span>{" "}
            (requerido)
          </li>
          <li>
            <span className="text-foreground font-mono">Descripción</span> /{" "}
            <span className="text-foreground font-mono">Costo</span> /{" "}
            <span className="text-foreground font-mono">Margen</span>
          </li>
          <li>
            <span className="text-foreground font-mono">Precio Final</span> /{" "}
            <span className="text-foreground font-mono">Stock</span> /{" "}
            <span className="text-foreground font-mono">Categoría</span> /{" "}
            <span className="text-foreground font-mono">Imagen URL</span>
          </li>
        </ul>
        <p className="text-[11px] mt-2">
          Los nombres se aceptan en mayúscula/minúscula y con sinónimos
          comunes (ej: DESCRIPCION, CATEGORIA, LINK FOTO).
        </p>
      </div>
    </div>
  );
}
