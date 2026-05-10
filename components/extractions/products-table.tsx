"use client";

import { useState, useMemo } from "react";
import { formatPrice } from "@/lib/utils";
import { ExternalLink, Search } from "lucide-react";
import type { ExtractedProduct } from "@prisma/client";

type Filter = "all" | "withPrice" | "withoutPrice" | "withoutSku";

const filters: { value: Filter; label: string }[] = [
  { value: "all", label: "Todos" },
  { value: "withPrice", label: "Con precio" },
  { value: "withoutPrice", label: "Sin precio" },
  { value: "withoutSku", label: "Sin SKU" },
];

export function ProductsTable({ products }: { products: ExtractedProduct[] }) {
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");

  const filtered = useMemo(() => {
    const q = search.toLowerCase().trim();
    return products.filter((p) => {
      if (filter === "withPrice" && !p.wholesalePrice) return false;
      if (filter === "withoutPrice" && p.wholesalePrice) return false;
      if (filter === "withoutSku" && p.sku) return false;
      if (!q) return true;
      return (
        p.name.toLowerCase().includes(q) ||
        (p.sku ?? "").toLowerCase().includes(q)
      );
    });
  }, [products, search, filter]);

  return (
    <div className="bg-card border border-border rounded-xl overflow-hidden">
      <div className="px-5 py-3 border-b border-border flex flex-col md:flex-row md:items-center justify-between gap-3">
        <h2 className="font-semibold text-sm">
          Productos ({filtered.length}
          {filtered.length !== products.length ? ` de ${products.length}` : ""})
        </h2>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por nombre o SKU…"
              className="text-xs bg-background border border-border rounded-md pl-8 pr-3 py-1.5 w-64 focus:outline-none focus:ring-1 focus:ring-primary/60"
            />
          </div>
          <div className="flex bg-muted/30 rounded-md p-0.5 gap-0.5">
            {filters.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => setFilter(f.value)}
                className={`text-[11px] px-2.5 py-1 rounded transition-colors ${
                  filter === f.value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border bg-muted/20">
              {["SKU", "Nombre", "Precio", "Precio ant.", "Stock", "Categoría", "URL"].map((h) => (
                <th
                  key={h}
                  className="text-left px-4 py-2.5 font-medium text-muted-foreground uppercase tracking-wider whitespace-nowrap"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((p, i) => (
              <tr
                key={p.id}
                className={
                  i % 2 === 1
                    ? "bg-[hsl(var(--surface-row))] hover:bg-muted/30"
                    : "hover:bg-muted/20"
                }
              >
                <td className="px-4 py-2.5 font-mono text-muted-foreground">
                  {p.sku ?? "—"}
                </td>
                <td className="px-4 py-2.5 max-w-xs truncate font-medium">
                  {p.name}
                </td>
                <td className="px-4 py-2.5 font-mono text-accent">
                  {p.wholesalePrice ? formatPrice(Number(p.wholesalePrice)) : "—"}
                </td>
                <td className="px-4 py-2.5 font-mono text-muted-foreground line-through">
                  {p.oldPrice ? formatPrice(Number(p.oldPrice)) : ""}
                </td>
                <td className="px-4 py-2.5">{p.stock ?? "—"}</td>
                <td className="px-4 py-2.5 text-muted-foreground">
                  {p.category ?? "—"}
                </td>
                <td className="px-4 py-2.5">
                  {p.productUrl && (
                    <a
                      href={p.productUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline flex items-center gap-1"
                    >
                      Ver <ExternalLink className="w-3 h-3" />
                    </a>
                  )}
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-muted-foreground">
                  Sin resultados
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
