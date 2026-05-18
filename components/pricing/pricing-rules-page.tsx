"use client";

import { useState, useEffect } from "react";
import { toast } from "sonner";
import {
  Tag,
  Plus,
  Edit,
  Trash2,
  Loader2,
  Globe,
  Store as StoreIcon,
  FolderTree,
} from "lucide-react";

type Scope = "GLOBAL" | "PROVIDER" | "CATEGORY";
type Rounding = "NONE" | "CEIL" | "NEAREST_100" | "NEAREST_500" | "ENDING_990";

interface Rule {
  id: string;
  name: string;
  scope: Scope;
  scopeId: string | null;
  scopeName: string | null;
  marginPercent: number;
  roundingMode: Rounding;
  isActive: boolean;
  priority: number;
  createdAt: string;
}

interface Props {
  providers: { id: string; name: string }[];
  categories: { id: string; name: string }[];
}

const scopeBadge: Record<Scope, { label: string; icon: typeof Globe; cls: string }> = {
  GLOBAL: { label: "Global", icon: Globe, cls: "bg-primary/15 text-primary border-primary/30" },
  PROVIDER: { label: "Proveedor", icon: StoreIcon, cls: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30" },
  CATEGORY: { label: "Categoría", icon: FolderTree, cls: "bg-purple-500/15 text-purple-300 border-purple-500/30" },
};

const roundingLabel: Record<Rounding, string> = {
  NONE: "Sin redondeo",
  CEIL: "Entero superior",
  NEAREST_100: "Múltiplo de 100",
  NEAREST_500: "Múltiplo de 500",
  ENDING_990: "Termina en 990",
};

export function PricingRulesPage({ providers, categories }: Props) {
  const [rules, setRules] = useState<Rule[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Rule | null>(null);
  const [creating, setCreating] = useState(false);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/pricing-rules");
      if (!res.ok) throw new Error("Error al cargar reglas");
      const data = (await res.json()) as { rules: Rule[] };
      setRules(data.rules);
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function handleDelete(id: string) {
    if (!window.confirm("¿Eliminar esta regla? Los productos vinculados quedarán sin regla.")) return;
    try {
      const res = await fetch(`/api/pricing-rules/${id}`, { method: "DELETE" });
      if (!res.ok) throw new Error("Error al eliminar");
      toast.success("Regla eliminada");
      load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  async function handleToggleActive(rule: Rule) {
    try {
      const res = await fetch(`/api/pricing-rules/${rule.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !rule.isActive }),
      });
      if (!res.ok) throw new Error("Error");
      load();
    } catch (err) {
      toast.error((err as Error).message);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reglas de pricing</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Calculá precios de venta a partir del costo mayorista
          </p>
        </div>
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="flex items-center gap-2 bg-primary text-primary-foreground px-4 py-2 rounded-lg text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          <Plus className="w-4 h-4" /> Nueva regla
        </button>
      </div>

      {loading ? (
        <div className="bg-card border border-border rounded-xl py-12 text-center text-muted-foreground">
          <Loader2 className="w-5 h-5 animate-spin inline-block mr-2" />
          Cargando...
        </div>
      ) : rules.length === 0 ? (
        <div className="bg-card border border-border rounded-xl py-12 text-center text-sm text-muted-foreground">
          Sin reglas todavía.{" "}
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="text-primary hover:underline"
          >
            Crear la primera →
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {rules.map((rule) => {
            const sb = scopeBadge[rule.scope];
            return (
              <div
                key={rule.id}
                className="bg-card border border-border rounded-xl p-5 flex flex-col gap-3"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="font-semibold text-sm truncate">{rule.name}</p>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {rule.scope === "GLOBAL"
                        ? "Aplica a todos los productos sin regla más específica"
                        : `${rule.scope === "PROVIDER" ? "Proveedor" : "Categoría"}: ${rule.scopeName ?? "?"}`}
                    </p>
                  </div>
                  <span
                    className={`text-[10px] px-2 py-0.5 rounded-full border font-medium inline-flex items-center gap-1 ${sb.cls}`}
                  >
                    <sb.icon className="w-2.5 h-2.5" />
                    {sb.label}
                  </span>
                </div>

                <div className="bg-muted/20 border border-border rounded-lg p-3 space-y-1">
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">Margen</span>
                    <span className="text-lg font-semibold">+{rule.marginPercent}%</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Redondeo</span>
                    <span>{roundingLabel[rule.roundingMode]}</span>
                  </div>
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Prioridad</span>
                    <span className="font-mono">{rule.priority}</span>
                  </div>
                </div>

                <div className="flex items-center justify-between pt-1 border-t border-border">
                  <button
                    type="button"
                    onClick={() => handleToggleActive(rule)}
                    className={`text-xs px-2.5 py-1 rounded-md border transition-colors ${
                      rule.isActive
                        ? "bg-accent/15 text-accent border-accent/30"
                        : "bg-muted/40 text-muted-foreground border-border"
                    }`}
                  >
                    {rule.isActive ? "Activa" : "Inactiva"}
                  </button>
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => setEditing(rule)}
                      className="text-xs flex items-center gap-1 border border-border px-2 py-1 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/40"
                    >
                      <Edit className="w-3 h-3" /> Editar
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(rule.id)}
                      className="text-xs flex items-center gap-1 border border-red-500/30 px-2 py-1 rounded-md text-red-300 hover:bg-red-500/10"
                    >
                      <Trash2 className="w-3 h-3" /> Eliminar
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(creating || editing) && (
        <PricingRuleModal
          rule={editing}
          providers={providers}
          categories={categories}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}

function PricingRuleModal({
  rule,
  providers,
  categories,
  onClose,
  onSaved,
}: {
  rule: Rule | null;
  providers: Props["providers"];
  categories: Props["categories"];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(rule?.name ?? "");
  const [scope, setScope] = useState<Scope>(rule?.scope ?? "GLOBAL");
  const [scopeId, setScopeId] = useState(rule?.scopeId ?? "");
  const [marginPercent, setMarginPercent] = useState<string>(
    rule?.marginPercent != null ? String(rule.marginPercent) : "30"
  );
  const [roundingMode, setRoundingMode] = useState<Rounding>(rule?.roundingMode ?? "NONE");
  const [priority, setPriority] = useState<string>(String(rule?.priority ?? 0));
  const [isActive, setIsActive] = useState(rule?.isActive ?? true);
  const [saving, setSaving] = useState(false);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (scope !== "GLOBAL" && !scopeId) {
      toast.error("Seleccioná un proveedor o categoría");
      return;
    }
    setSaving(true);
    try {
      const body = {
        name: name.trim(),
        scope,
        scopeId: scope === "GLOBAL" ? null : scopeId,
        marginPercent: parseFloat(marginPercent),
        roundingMode,
        isActive,
        priority: parseInt(priority, 10) || 0,
      };
      const res = await fetch(
        rule ? `/api/pricing-rules/${rule.id}` : "/api/pricing-rules",
        {
          method: rule ? "PATCH" : "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error ?? "Error al guardar");
      }
      toast.success(rule ? "Regla actualizada" : "Regla creada");
      onSaved();
    } catch (err) {
      toast.error((err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 bg-black/50 z-40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center px-4 pointer-events-none">
        <form
          onSubmit={save}
          className="bg-card border border-border rounded-xl shadow-2xl shadow-black/40 w-full max-w-md p-6 space-y-4 pointer-events-auto"
        >
          <div className="flex items-center gap-2">
            <Tag className="w-4 h-4 text-primary" />
            <h3 className="font-semibold">{rule ? "Editar regla" : "Nueva regla"}</h3>
          </div>

          <div>
            <label className="block text-[11px] text-muted-foreground mb-1">Nombre</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              maxLength={80}
              placeholder="Ej: Margen global 35%"
              className="w-full text-sm bg-background border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
            />
          </div>

          <div>
            <label className="block text-[11px] text-muted-foreground mb-1">Alcance</label>
            <select
              value={scope}
              onChange={(e) => {
                setScope(e.target.value as Scope);
                setScopeId("");
              }}
              className="w-full text-sm bg-background border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
            >
              <option value="GLOBAL">Global (todos los productos)</option>
              <option value="PROVIDER">Por proveedor</option>
              <option value="CATEGORY">Por categoría</option>
            </select>
          </div>

          {scope === "PROVIDER" && (
            <div>
              <label className="block text-[11px] text-muted-foreground mb-1">Proveedor</label>
              <select
                value={scopeId}
                onChange={(e) => setScopeId(e.target.value)}
                required
                className="w-full text-sm bg-background border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
              >
                <option value="">Seleccionar...</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </div>
          )}

          {scope === "CATEGORY" && (
            <div>
              <label className="block text-[11px] text-muted-foreground mb-1">Categoría</label>
              {categories.length === 0 ? (
                <p className="text-xs text-muted-foreground bg-muted/20 border border-border rounded-md p-2">
                  No hay categorías creadas. La gestión de categorías está próximamente.
                </p>
              ) : (
                <select
                  value={scopeId}
                  onChange={(e) => setScopeId(e.target.value)}
                  required
                  className="w-full text-sm bg-background border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
                >
                  <option value="">Seleccionar...</option>
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] text-muted-foreground mb-1">Margen %</label>
              <input
                type="number"
                step="0.1"
                value={marginPercent}
                onChange={(e) => setMarginPercent(e.target.value)}
                required
                className="w-full text-sm bg-background border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
              />
            </div>
            <div>
              <label className="block text-[11px] text-muted-foreground mb-1">Prioridad</label>
              <input
                type="number"
                step="1"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                title="Cuando dos reglas del mismo alcance compiten, gana la de mayor prioridad"
                className="w-full text-sm bg-background border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
              />
            </div>
          </div>

          <div>
            <label className="block text-[11px] text-muted-foreground mb-1">Redondeo</label>
            <select
              value={roundingMode}
              onChange={(e) => setRoundingMode(e.target.value as Rounding)}
              className="w-full text-sm bg-background border border-border rounded-md px-2.5 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/60"
            >
              <option value="NONE">Sin redondeo</option>
              <option value="CEIL">
                Redondear al entero superior (↑ $1.075,45 → $1.076)
              </option>
              <option value="NEAREST_100">Redondear al 100 más cercano</option>
              <option value="NEAREST_500">Redondear al 500 más cercano</option>
              <option value="ENDING_990">Terminar en .990</option>
            </select>
          </div>

          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(e) => setIsActive(e.target.checked)}
              className="accent-primary"
            />
            Regla activa
          </label>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-border">
            <button
              type="button"
              onClick={onClose}
              className="text-xs px-3 py-1.5 rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-muted/40"
            >
              Cancelar
            </button>
            <button
              type="submit"
              disabled={saving}
              className="text-xs flex items-center gap-1.5 bg-primary text-primary-foreground px-4 py-1.5 rounded-md hover:bg-primary/90 disabled:opacity-60"
            >
              {saving && <Loader2 className="w-3 h-3 animate-spin" />}
              {rule ? "Guardar cambios" : "Crear regla"}
            </button>
          </div>
        </form>
      </div>
    </>
  );
}
