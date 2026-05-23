"use client";

import { useState } from "react";
import { Boxes, Link2, FolderTree } from "lucide-react";
import { PublicationsTable } from "./publications-table";
import { UnmatchedTable } from "./unmatched-table";
import { CategoriesTable } from "./categories-table";

type Tab = "publications" | "unmatched" | "categories";

interface CategoryOpt {
  id: string;
  name: string;
}

interface Props {
  publicationsTotal: number;
  unmatchedCount: number;
  categories: CategoryOpt[];
  /// Total de StoreCategory (categorías importadas desde la tienda externa).
  /// Es lo que efectivamente muestra la tab Categorías y la barra superior.
  /// `categories` arriba refiere a las Category internas de PricEcom (sugerencias).
  categoriesTotal: number;
}

export function MyStoreTabs({
  publicationsTotal,
  unmatchedCount: initialUnmatchedCount,
  categories,
  categoriesTotal,
}: Props) {
  const [tab, setTab] = useState<Tab>("publications");
  // El conteo inicial viene del server, pero `UnmatchedTable` re-fetchea cada
  // vez que se monta y/o cuando el usuario sincroniza desde WooCommerce.
  // Mantenemos el badge alineado a lo que la tabla realmente muestra.
  const [unmatchedCount, setUnmatchedCount] = useState(initialUnmatchedCount);

  const tabs: { key: Tab; label: string; count?: number; icon: typeof Boxes }[] = [
    {
      key: "publications",
      label: "Publicaciones",
      count: publicationsTotal,
      icon: Boxes,
    },
    { key: "unmatched", label: "No vinculados", count: unmatchedCount, icon: Link2 },
    { key: "categories", label: "Categorías", count: categoriesTotal, icon: FolderTree },
  ];

  return (
    <div className="space-y-4">
      <div className="border-b border-border flex items-center gap-1 flex-wrap">
        {tabs.map((t) => {
          const Icon = t.icon;
          const active = tab === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px flex items-center gap-2 transition-colors ${
                active
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {t.label}
              {t.count != null && (
                <span
                  className={`text-[10px] font-mono px-1.5 py-0.5 rounded-full ${
                    active
                      ? "bg-primary/15 text-primary"
                      : "bg-muted/40 text-muted-foreground"
                  }`}
                >
                  {t.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {tab === "publications" && <PublicationsTable />}
      {tab === "unmatched" && (
        <UnmatchedTable onCountLoaded={setUnmatchedCount} />
      )}
      {tab === "categories" && <CategoriesTable categories={categories} />}
    </div>
  );
}
