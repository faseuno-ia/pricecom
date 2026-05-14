export function Footer() {
  return (
    <footer className="border-t border-border px-8 py-4 flex flex-col md:flex-row items-center md:justify-between gap-1 text-[11px] text-muted-foreground">
      <p>
        <span className="font-semibold text-foreground/80">PricEcom</span>
        <span className="mx-2 opacity-40">·</span>
        v0.2.0
      </p>
      <p>Uso autorizado únicamente. Inteligencia de precios mayoristas.</p>
    </footer>
  );
}
