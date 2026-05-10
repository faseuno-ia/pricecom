import { prisma } from "@/lib/db/client";
import { formatDate } from "@/lib/utils";
import {
  Store, Download, Package, AlertCircle, ArrowRight, Clock
} from "lucide-react";
import Link from "next/link";

async function getDashboardStats() {
  const [
    totalProviders,
    activeProviders,
    recentJobs,
    totalProducts,
    failedJobs,
  ] = await Promise.all([
    prisma.provider.count(),
    prisma.provider.count({ where: { isActive: true } }),
    prisma.extractionJob.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      include: { provider: { select: { name: true } } },
    }),
    prisma.extractedProduct.count(),
    prisma.extractionJob.count({ where: { status: "FAILED" } }),
  ]);

  return { totalProviders, activeProviders, recentJobs, totalProducts, failedJobs };
}

const statusLabels: Record<string, string> = {
  PENDING: "Pendiente",
  RUNNING: "En proceso",
  COMPLETED: "Completado",
  FAILED: "Fallido",
  CANCELLED: "Cancelado",
};

const statusClass: Record<string, string> = {
  PENDING: "badge-pending",
  RUNNING: "badge-running",
  COMPLETED: "badge-completed",
  FAILED: "badge-failed",
  CANCELLED: "badge-cancelled",
};

export default async function DashboardPage() {
  const stats = await getDashboardStats();

  const cards = [
    {
      label: "Proveedores activos",
      value: stats.activeProviders,
      sub: `${stats.totalProviders} en total`,
      icon: Store,
      color: "bg-blue-50 text-blue-600",
    },
    {
      label: "Productos extraídos",
      value: stats.totalProducts.toLocaleString("es-AR"),
      sub: "Total histórico",
      icon: Package,
      color: "bg-emerald-50 text-emerald-600",
    },
    {
      label: "Extracciones totales",
      value: stats.recentJobs.length > 0 ? "Ver historial" : "0",
      sub: "Últimas 5 mostradas",
      icon: Download,
      color: "bg-violet-50 text-violet-600",
    },
    {
      label: "Errores",
      value: stats.failedJobs,
      sub: "Jobs fallidos",
      icon: AlertCircle,
      color: "bg-red-50 text-red-600",
    },
  ];

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">Dashboard</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Resumen general de extracciones y proveedores
          </p>
        </div>
        <Link
          href="/new-extraction"
          className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          Nueva extracción
          <ArrowRight className="w-4 h-4" />
        </Link>
      </div>

      {/* Stat cards */}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-4">
        {cards.map((card) => (
          <div key={card.label} className="bg-card border rounded-xl p-5">
            <div className="flex items-start justify-between">
              <div>
                <p className="text-xs text-muted-foreground font-medium uppercase tracking-wide">
                  {card.label}
                </p>
                <p className="text-2xl font-semibold mt-1.5">{card.value}</p>
                <p className="text-xs text-muted-foreground mt-1">{card.sub}</p>
              </div>
              <div className={`w-9 h-9 rounded-lg flex items-center justify-center ${card.color}`}>
                <card.icon className="w-4.5 h-4.5" size={18} />
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Recent jobs */}
      <div className="bg-card border rounded-xl">
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="font-semibold text-sm">Extracciones recientes</h2>
          <Link href="/extractions" className="text-xs text-primary hover:underline flex items-center gap-1">
            Ver todas <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
        {stats.recentJobs.length === 0 ? (
          <div className="flex flex-col items-center py-12 text-muted-foreground">
            <Clock className="w-8 h-8 mb-2 opacity-30" />
            <p className="text-sm">Sin extracciones todavía</p>
            <Link href="/new-extraction" className="text-primary text-sm mt-2 hover:underline">
              Iniciar primera extracción
            </Link>
          </div>
        ) : (
          <div className="divide-y">
            {stats.recentJobs.map((job) => (
              <div key={job.id} className="flex items-center justify-between px-6 py-3.5 hover:bg-muted/30 transition-colors">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-muted flex items-center justify-center">
                    <Store className="w-3.5 h-3.5 text-muted-foreground" />
                  </div>
                  <div>
                    <p className="text-sm font-medium">{job.provider.name}</p>
                    <p className="text-xs text-muted-foreground">{formatDate(job.createdAt)}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4">
                  {job.totalProducts > 0 && (
                    <span className="text-sm text-muted-foreground">{job.totalProducts} productos</span>
                  )}
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusClass[job.status]}`}>
                    {statusLabels[job.status]}
                  </span>
                  <Link href={`/extractions/${job.id}`} className="text-xs text-primary hover:underline">
                    Ver
                  </Link>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Disclaimer */}
      <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex gap-3">
        <AlertCircle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
        <p className="text-xs text-amber-800">
          <strong>Uso responsable:</strong> Esta herramienta debe usarse únicamente sobre sitios donde
          el usuario tenga autorización, acceso legítimo o relación comercial con el proveedor.
        </p>
      </div>
    </div>
  );
}
