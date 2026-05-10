import { cn } from "@/lib/utils";

const labels: Record<string, string> = {
  PENDING: "Pendiente",
  RUNNING: "En proceso",
  COMPLETED: "Completado",
  FAILED: "Fallido",
  CANCELLED: "Cancelado",
};

const classes: Record<string, string> = {
  PENDING: "badge-pending",
  RUNNING: "badge-running",
  COMPLETED: "badge-completed",
  FAILED: "badge-failed",
  CANCELLED: "badge-cancelled",
};

export function StatusBadge({
  status,
  size = "sm",
  className,
}: {
  status: string;
  size?: "sm" | "md";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full font-medium",
        size === "md" ? "text-sm px-3 py-1" : "text-xs px-2 py-0.5",
        classes[status] ?? "badge-cancelled",
        className
      )}
    >
      {labels[status] ?? status}
    </span>
  );
}
