import { LoginForm } from "@/components/auth/login-form";
import { Hexagon } from "lucide-react";

export const metadata = {
  title: "Ingresar — PricEcom",
};

export default function LoginPage() {
  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center mb-8">
          <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-primary to-accent flex items-center justify-center shadow-lg shadow-primary/30 relative mb-4">
            <Hexagon className="w-10 h-10 text-white/10 absolute" strokeWidth={1.5} />
            <span className="font-bold text-white text-lg tracking-tight relative">
              PE
            </span>
          </div>
          <h1 className="font-bold text-2xl tracking-tight">
            Pric
            <span className="bg-gradient-to-r from-green-400 to-blue-500 bg-clip-text text-transparent font-extrabold">
              E
            </span>
            com
          </h1>
          <p className="text-xs text-muted-foreground mt-1">
            Inteligencia de precios
          </p>
        </div>

        <div className="bg-card border border-border rounded-2xl p-6 shadow-2xl shadow-black/20">
          <LoginForm />
        </div>

        <p className="text-[10px] text-muted-foreground/60 text-center mt-6">
          Solo uso autorizado
        </p>
      </div>
    </div>
  );
}
