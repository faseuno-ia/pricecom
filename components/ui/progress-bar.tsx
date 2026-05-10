export function ProgressBar({
  value,
  label,
  detail,
}: {
  value: number;
  label?: string;
  detail?: string;
}) {
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="space-y-1.5">
      {(label || detail) && (
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{label}</span>
          <span className="font-mono text-foreground">
            {detail ?? `${pct}%`}
          </span>
        </div>
      )}
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <div
          className="h-full bg-primary rounded-full transition-all duration-500"
          style={{ width: `${Math.max(2, pct)}%` }}
        />
      </div>
    </div>
  );
}
