import type { Metadata } from "next";
import "./globals.css";
import { Sidebar } from "@/components/layout/sidebar";
import { Footer } from "@/components/layout/footer";
import { Toaster } from "sonner";

export const metadata: Metadata = {
  title: "PricEcom — Inteligencia de precios",
  description: "Extractor y monitor de listas de precios de proveedores mayoristas",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className="dark">
      <body className="min-h-screen bg-background text-foreground flex">
        <Sidebar />
        <div className="flex-1 ml-64 flex flex-col min-h-screen">
          <main className="flex-1">
            <div className="max-w-7xl mx-auto p-8">{children}</div>
          </main>
          <Footer />
        </div>
        <Toaster richColors theme="dark" position="top-right" />
      </body>
    </html>
  );
}
