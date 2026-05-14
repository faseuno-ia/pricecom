import type { Metadata } from "next";
import "./globals.css";
import { Toaster } from "sonner";
import { SessionProvider } from "@/components/auth/session-provider";

export const metadata: Metadata = {
  title: "PricEcom — Inteligencia de precios",
  description: "Extractor y monitor de listas de precios de proveedores mayoristas",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className="dark">
      <body className="min-h-screen bg-background text-foreground">
        <SessionProvider>{children}</SessionProvider>
        <Toaster richColors theme="dark" position="top-right" />
      </body>
    </html>
  );
}
