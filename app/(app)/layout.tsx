import { Sidebar } from "@/components/layout/sidebar";
import { Footer } from "@/components/layout/footer";

// Layout para todas las rutas autenticadas. El middleware bloquea el acceso a
// estas rutas si no hay sesión, así que aquí asumimos usuario logueado.
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex">
      <Sidebar />
      <div className="flex-1 ml-64 flex flex-col min-h-screen">
        <main className="flex-1">
          <div className="max-w-7xl mx-auto p-8">{children}</div>
        </main>
        <Footer />
      </div>
    </div>
  );
}
