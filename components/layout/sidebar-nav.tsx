"use client";

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
} from "lucide-react";
import { cn } from "@/lib/utils";

const navItems = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard, highlight: false, badge: false as const },
  { href: "/providers", label: "Proveedores", icon: Store, highlight: false, badge: false as const },
  { href: "/extractions", label: "Extracciones", icon: Download, highlight: false, badge: "queue" as const },
  { href: "/new-extraction", label: "Nueva extracción", icon: PlusCircle, highlight: true, badge: false as const },
];

export function SidebarNav({ queueDepth }: { queueDepth: number }) {
  const pathname = usePathname();
  const { data: session } = useSession();
  const userDisplay = session?.user?.name || session?.user?.email || "Sesión activa";

  return (
    <aside className="fixed left-0 top-0 h-full w-64 bg-[hsl(var(--sidebar))] text-foreground border-r border-border flex flex-col z-10">
      <Link href="/dashboard" className="px-5 py-5 border-b border-border flex items-center gap-3 hover:bg-muted/20 transition-colors">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-lg shadow-primary/20 relative">
          <Hexagon className="w-7 h-7 text-white/10 absolute" strokeWidth={1.5} />
          <span className="font-bold text-white text-[13px] tracking-tight relative">PE</span>
        </div>
        <div>
          <span className="font-bold text-lg tracking-tight">
            Pric<span className="bg-gradient-to-r from-green-400 to-blue-500 bg-clip-text text-transparent font-extrabold">E</span>com
          </span>
          <p className="text-[10px] text-muted-foreground mt-1.5 leading-none">
            Inteligencia de precios
          </p>
        </div>
      </Link>

      <nav className="flex-1 p-3 space-y-0.5">
        {navItems.map(({ href, label, icon: Icon, highlight, badge }) => {
          const active = pathname === href || pathname.startsWith(href + "/");
          const showBadge = badge === "queue" && queueDepth > 0;
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "relative flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-all",
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
              <Icon className="w-4 h-4 flex-shrink-0" />
              <span className="flex-1">{label}</span>
              {showBadge && (
                <span className="text-[10px] font-semibold px-1.5 min-w-[20px] h-5 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground">
                  {queueDepth}
                </span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="px-3 py-3 border-t border-border space-y-2">
        <button
          type="button"
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs text-muted-foreground hover:bg-muted/30 hover:text-foreground transition-colors"
          title={userDisplay}
        >
          <LogOut className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="truncate flex-1 text-left">{userDisplay}</span>
        </button>
        <p className="text-[10px] text-muted-foreground/60 text-center">
          v0.3.0 · Solo uso autorizado
        </p>
      </div>
    </aside>
  );
}
