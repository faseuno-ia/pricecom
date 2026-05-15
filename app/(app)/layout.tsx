import { Sidebar } from "@/components/layout/sidebar";
import { Footer } from "@/components/layout/footer";

// Layout para todas las rutas autenticadas. El middleware bloquea el acceso a
// estas rutas si no hay sesión, así que aquí asumimos usuario logueado.
// El ancho de la sidebar y el margen del main lo manejan clases CSS
// (.app-sidebar / .app-main-content) que reaccionan al atributo
// `data-sidebar` sobre <html>, seteado por SidebarClient desde React state.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div>
      <Sidebar />
      <div className="app-main-content flex flex-col min-h-screen">
        <main className="flex-1">
          <div className="max-w-7xl mx-auto p-8">{children}</div>
        </main>
        <Footer />
      </div>
    </div>
  );
}
