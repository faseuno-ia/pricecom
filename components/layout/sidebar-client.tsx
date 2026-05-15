"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { signOut, useSession } from "next-auth/react";
import {
  LayoutDashboard,
  Store,
  Download,
  PlusCircle,
  Hexagon,
  LogOut,
  TrendingUp,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, highlight: false, badge: false as const },
  { href: "/providers", label: "Proveedores", icon: Store, highlight: false, badge: false as const },
  { href: "/extractions", label: "Extracciones", icon: Download, highlight: false, badge: "queue" as const },
  { href: "/changes", label: "Cambios", icon: TrendingUp, highlight: false, badge: false as const },
  { href: "/new-extraction", label: "Nueva extracción", icon: PlusCircle, highlight: true, badge: false as const },
];

const STORAGE_KEY = "sidebar-collapsed";

function isChangesRoute(pathname: string | null): boolean {
  return !!pathname && pathname.startsWith("/changes");
}

export function SidebarClient({ queueDepth }: { queueDepth: number }) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const userDisplay = session?.user?.name || session?.user?.email || "Sesión activa";

  // SSR/initial render: expanded por default. Tras montar, hidratamos desde
  // localStorage; si no hay preferencia y estamos en /changes, default colapsado.
  const [collapsed, setCollapsed] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    const stored = typeof window !== "undefined" ? localStorage.getItem(STORAGE_KEY) : null;
    if (stored === "true") setCollapsed(true);
    else if (stored === "false") setCollapsed(false);
    else if (isChangesRoute(window.location.pathname)) setCollapsed(true);
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!hydrated) return;
    localStorage.setItem(STORAGE_KEY, String(collapsed));
    document.documentElement.setAttribute(
      "data-sidebar",
      collapsed ? "collapsed" : "expanded"
    );
  }, [collapsed, hydrated]);

  return (
    <aside className="app-sidebar fixed left-0 top-0 h-full bg-[hsl(var(--sidebar))] text-foreground border-r border-border flex flex-col z-10 overflow-hidden">
      {/* Logo */}
      <Link
        href="/dashboard"
        className={cn(
          "border-b border-border flex items-center hover:bg-muted/20 transition-colors",
          collapsed ? "px-3 py-4 justify-center" : "px-5 py-5 gap-3"
        )}
        title={collapsed ? "PricEcom" : undefined}
      >
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-lg shadow-primary/20 relative flex-shrink-0">
          <Hexagon className="w-7 h-7 text-white/10 absolute" strokeWidth={1.5} />
          <span className="font-bold text-white text-[13px] tracking-tight relative">PE</span>
        </div>
        {!collapsed && (
          <div className="min-w-0">
            <span className="font-bold text-lg tracking-tight">
              Pric
              <span className="bg-gradient-to-r from-green-400 to-blue-500 bg-clip-text text-transparent font-extrabold">
                E
              </span>
              com
            </span>
            <p className="text-[10px] text-muted-foreground mt-1.5 leading-none">
              Inteligencia de precios
            </p>
          </div>
        )}
      </Link>

      {/* Nav */}
      <nav className={cn("flex-1 space-y-0.5", collapsed ? "p-2" : "p-3")}>
        {navItems.map(({ href, label, icon: Icon, highlight, badge }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          const showBadge = badge === "queue" && queueDepth > 0;
          return (
            <Link
              key={href}
              href={href}
              title={collapsed ? label : undefined}
              className={cn(
                "relative flex items-center text-sm font-medium transition-all rounded-lg",
                collapsed ? "justify-center px-2 py-2.5" : "gap-3 px-3 py-2.5",
                active
                  ? "bg-primary/10 text-primary"
                  : highlight
                  ? "bg-accent/10 text-accent hover:bg-accent/20"
                  : "text-muted-foreground hover:bg-muted/30 hover:text-foreground"
              )}
            >
              {active && (
                <span className="absolute left-0 top-1.5 bottom-1.5 w-1 bg-primary rounded-r-full" />
              )}
              <div className="relative">
                <Icon className="w-4 h-4 flex-shrink-0" />
                {/* Badge en colapsado: punto, no número */}
                {collapsed && showBadge && (
                  <span className="absolute -top-1 -right-1 w-2 h-2 rounded-full bg-primary ring-2 ring-[hsl(var(--sidebar))]" />
                )}
              </div>
              {!collapsed && <span className="flex-1">{label}</span>}
              {!collapsed && showBadge && (
                <span className="text-[10px] font-semibold px-1.5 min-w-[20px] h-5 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground">
                  {queueDepth}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      {/* Toggle + logout */}
      <div
        className={cn(
          "border-t border-border space-y-1.5",
          collapsed ? "p-2" : "p-3"
        )}
      >
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          title={collapsed ? "Expandir sidebar" : "Colapsar sidebar"}
          className={cn(
            "w-full flex items-center rounded-lg text-xs text-muted-foreground hover:bg-muted/30 hover:text-foreground transition-colors",
            collapsed ? "justify-center px-2 py-2" : "gap-2 px-3 py-2"
          )}
        >
          {collapsed ? (
            <ChevronRight className="w-3.5 h-3.5 flex-shrink-0" />
          ) : (
            <>
              <ChevronLeft className="w-3.5 h-3.5 flex-shrink-0" />
              <span>Colapsar</span>
            </>
          )}
        </button>

        <button
          type="button"
          onClick={() => signOut({ callbackUrl: "/login" })}
          title={collapsed ? userDisplay : userDisplay}
          className={cn(
            "w-full flex items-center rounded-lg text-xs text-muted-foreground hover:bg-muted/30 hover:text-foreground transition-colors",
            collapsed ? "justify-center px-2 py-2" : "gap-2 px-3 py-2"
          )}
        >
          <LogOut className="w-3.5 h-3.5 flex-shrink-0" />
          {!collapsed && (
            <span className="truncate flex-1 text-left">{userDisplay}</span>
          )}
        </button>

        {!collapsed && (
          <p className="text-[10px] text-muted-foreground/60 text-center pt-1">
            v0.3.0 · Solo uso autorizado
          </p>
        )}
      </div>
    </aside>
  );
}
