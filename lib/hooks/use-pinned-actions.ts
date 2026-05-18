"use client";

// Persistencia liviana de las "acciones masivas pineadas" del catálogo.
// Las pineadas se muestran como botones visibles en la barra masiva; las
// no pineadas quedan dentro del dropdown "Acciones".

import { useEffect, useState } from "react";

const STORAGE_KEY = "pricecom.catalog.pinnedBulkActions";
const DEFAULT_PINNED: string[] = ["apply_margin"];

function readStored(): string[] {
  if (typeof window === "undefined") return DEFAULT_PINNED;
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (!stored) return DEFAULT_PINNED;
    const parsed = JSON.parse(stored);
    return Array.isArray(parsed) ? parsed : DEFAULT_PINNED;
  } catch {
    return DEFAULT_PINNED;
  }
}

export function usePinnedActions() {
  // Estado inicial seguro para SSR: default. Después de hidratar leemos
  // localStorage para evitar mismatch.
  const [pinned, setPinned] = useState<string[]>(DEFAULT_PINNED);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setPinned(readStored());
    setHydrated(true);
  }, []);

  function persist(next: string[]) {
    setPinned(next);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        /* localStorage puede no estar disponible (modo incógnito strict) */
      }
    }
  }

  function togglePin(action: string) {
    persist(
      pinned.includes(action)
        ? pinned.filter((a) => a !== action)
        : [...pinned, action]
    );
  }

  function isPinned(action: string) {
    return pinned.includes(action);
  }

  return { pinned, togglePin, isPinned, hydrated };
}
