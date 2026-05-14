import { ProviderForm } from "@/components/providers/provider-form";

export default function NewProviderPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Nuevo proveedor</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Configurá los datos básicos del proveedor mayorista
        </p>
      </div>
      <div className="bg-card border rounded-xl p-6">
        <ProviderForm />
      </div>
    </div>
  );
}
