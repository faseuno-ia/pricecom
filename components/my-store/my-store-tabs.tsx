"use client";

import { useState } from "react";
import { Boxes, Link2, FolderTree } from "lucide-react";
import {
  PublicationsTable,
} from "./publications-table";
import { UnmatchedTable } from "./unmatched-table";
import { CategoriesTable } from "./categories-table";

type Tab = "publications" | "unmatched" | "categories";

interface CategoryOpt {
  id: string;
  name: string;
}

interface Props {
  publications: React.ComponentProps<typeof PublicationsTable>["publications"];
  unmatchedCount: number;
  categories: CategoryOpt[];
}

export function MyStoreTabs({ publications, unmatchedCount, categories }: Props) {
  const [tab, setTab] = useState<Tab>("publications");

  const tabs: { key: Tab; label: string; count?: number; icon: typeof Boxes }[] = [
    { key: "publications", label: "Publicaciones", count: publications.length, icon: Boxes },
    { key: "unmatched", label: "No vinculados", count: unmatchedCount, icon: Link2 },
    { key: "categories", label: "Categorías", count: categories.length, icon: FolderTree },
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

      {tab === "publications" && <PublicationsTable publications={publications} />}
      {tab === "unmatched" && <UnmatchedTable />}
      {tab === "categories" && <CategoriesTable categories={categories} />}
    </div>
  );
}
