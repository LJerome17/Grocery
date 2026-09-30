"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/AppProvider";
import { AISLE_ORDER, aisleLabel } from "@/lib/aisles";
import type { ShoppingItem } from "@/lib/db";
import { messageFr } from "@/lib/erreur";
import { plural, tr } from "@/lib/i18n";
import { weekStart } from "@/lib/planner";
import { supabase } from "@/lib/supabase";

export default function ListePage() {
  return (
    <Suspense fallback={<p className="py-20 text-center text-muted">{tr("Chargement…", "Loading…")}</p>}>
      <Liste />
    </Suspense>
  );
}

function Liste() {
  const { householdId } = useApp();
  const requested = useSearchParams().get("plan");
  const [planId, setPlanId] = useState<string | null>(null);
  const [items, setItems] = useState<ShoppingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [newItem, setNewItem] = useState("");
  const [hideChecked, setHideChecked] = useState(false);
  const [showPantry, setShowPantry] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!householdId) return;
    const { data: plans, error: plansError } = await supabase()
      .from("week_plans")
      .select("id, week_start")
      .eq("household_id", householdId)
      .order("week_start", { ascending: false })
      .limit(6);
    // A failure is shown as such, never as "no list yet".
    if (plansError) {
      setError(messageFr(plansError));
      setLoading(false);
      return;
    }
    setError(null);
    // The plan asked for (from "Faire la liste"), else this week, then upcoming weeks, then past ones.
    const thisWeek = weekStart(new Date());
    const rank = (w: string) => (w === thisWeek ? 0 : w > thisWeek ? 1 : 2);
    const ordered = (plans ?? []).sort(
      (a, b) =>
        Number(b.id === requested) - Number(a.id === requested) ||
        rank(a.week_start) - rank(b.week_start) ||
        (rank(a.week_start) === 1 ? a.week_start.localeCompare(b.week_start) : b.week_start.localeCompare(a.week_start)),
    );
    for (const p of ordered) {
      const { data } = await supabase().from("shopping_items").select("*").eq("plan_id", p.id).order("position");
      if (data?.length) {
        setPlanId(p.id);
        setItems(data as ShoppingItem[]);
        setLoading(false);
        return;
      }
    }
    setPlanId(ordered[0]?.id ?? null);
    setItems([]);
    setLoading(false);
  }, [householdId, requested]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    load();
    // Phones drop the live connection when the screen sleeps: reload when the page comes back.
    const onVisible = () => document.visibilityState === "visible" && load();
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [load]);

  // Live sync: a box ticked on one phone shows up on the other.
  useEffect(() => {
    if (!planId) return;
    const channel = supabase()
      .channel(`liste-${planId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "shopping_items", filter: `plan_id=eq.${planId}` }, (payload) => {
        const row = payload.new as ShoppingItem;
        setItems((prev) => (prev.some((i) => i.id === row.id) ? prev : [...prev, row]));
      })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "shopping_items", filter: `plan_id=eq.${planId}` }, (payload) => {
        const row = payload.new as ShoppingItem;
        setItems((prev) => prev.map((i) => (i.id === row.id ? row : i)));
      })
      // Deletions cannot be filtered by plan (only the id is sent): unknown ids are simply ignored.
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "shopping_items" }, (payload) => {
        const id = (payload.old as { id: string }).id;
        setItems((prev) => prev.filter((i) => i.id !== id));
      })
      .subscribe();
    return () => {
      supabase().removeChannel(channel);
    };
  }, [planId]);

  async function toggle(item: ShoppingItem) {
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, checked: !item.checked } : i)));
    const { error } = await supabase().from("shopping_items").update({ checked: !item.checked }).eq("id", item.id);
    if (error) {
      // Not saved (bad network in the store): undo on screen so both phones stay the same.
      setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, checked: item.checked } : i)));
      setError(messageFr(error));
    }
  }

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    const label = newItem.trim();
    if (!label || !planId) return;
    setNewItem("");
    const { data, error } = await supabase()
      .from("shopping_items")
      .insert({ plan_id: planId, label, aisle: "autre", manual: true, position: 9999 })
      .select("*")
      .single();
    if (error) {
      setNewItem(label);
      return setError(messageFr(error));
    }
    if (data) setItems((prev) => (prev.some((i) => i.id === data.id) ? prev : [...prev, data as ShoppingItem]));
  }

  async function removeItem(item: ShoppingItem) {
    setItems((prev) => prev.filter((i) => i.id !== item.id));
    const { error } = await supabase().from("shopping_items").delete().eq("id", item.id);
    if (error) {
      setError(messageFr(error));
      load();
    }
  }

  async function clearChecked() {
    const ids = items.filter((i) => i.checked).map((i) => i.id);
    setItems((prev) => prev.filter((i) => !i.checked));
    if (!ids.length) return;
    const { error } = await supabase().from("shopping_items").delete().in("id", ids);
    if (error) {
      setError(messageFr(error));
      load();
    }
  }

  const groups = useMemo(() => {
    const shown = items.filter((i) => !i.pantry && !(hideChecked && i.checked));
    const byAisle = new Map<string, ShoppingItem[]>();
    for (const i of shown) byAisle.set(i.aisle, [...(byAisle.get(i.aisle) ?? []), i]);
    return [...byAisle].sort((a, b) => (AISLE_ORDER[a[0]] ?? 99) - (AISLE_ORDER[b[0]] ?? 99));
  }, [items, hideChecked]);
  const pantry = items.filter((i) => i.pantry);
  const remaining = items.filter((i) => !i.pantry && !i.checked).length;

  if (loading) return <p className="py-20 text-center text-muted">{tr("Chargement…", "Loading…")}</p>;

  if (!planId) {
    return (
      <div className="card mt-10 space-y-3 p-5 text-center">
        <p>{tr("Pas encore de liste. Choisissez d'abord les recettes de la semaine.", "No list yet. Pick this week's recipes first.")}</p>
        <Link href="/semaine" className="btn-primary">
          {tr("Planifier la semaine", "Plan the week")}
        </Link>
      </div>
    );
  }

  const Row = ({ item }: { item: ShoppingItem }) => (
    <li className="flex items-center gap-3 px-4 py-3">
      <button
        onClick={() => toggle(item)}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 ${item.checked ? "border-brand bg-brand text-white" : "border-line"}`}
        aria-label={item.checked ? tr("Décocher", "Uncheck") : tr("Cocher", "Check")}
      >
        {item.checked && "✓"}
      </button>
      <button onClick={() => toggle(item)} className={`flex-1 text-left ${item.checked ? "text-muted line-through" : ""}`}>
        <span className="font-medium">{item.label}</span>
        {item.quantity_text && <span className="ml-2 text-sm text-muted">{item.quantity_text}</span>}
      </button>
      {item.manual && (
        <button onClick={() => removeItem(item)} className="text-muted" aria-label={tr("Supprimer", "Delete")}>
          ✕
        </button>
      )}
    </li>
  );

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">{tr("Épicerie", "Groceries")}</h1>
          <p className="text-sm text-muted">{plural(remaining, ["article", "articles"], ["item", "items"])} {tr("à acheter", "to buy")}</p>
        </div>
        <button className={hideChecked ? "chip-on" : "chip"} onClick={() => setHideChecked(!hideChecked)}>
          {hideChecked ? tr("Tout afficher", "Show all") : tr("Masquer les cochés", "Hide checked")}
        </button>
      </header>

      {error && <p className="text-sm text-red-700">{error}</p>}

      <form onSubmit={addItem} className="flex gap-2">
        <input className="input" placeholder={tr("Ajouter un article (papier de toilette…)", "Add an item (toilet paper…)")} value={newItem} onChange={(e) => setNewItem(e.target.value)} />
        <button className="btn-primary" aria-label={tr("Ajouter", "Add")}>
          ＋
        </button>
      </form>

      {groups.map(([aisle, list]) => (
        <section key={aisle}>
          <h2 className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-muted">{aisleLabel(aisle)}</h2>
          <ul className="card divide-y divide-line">
            {list.map((i) => (
              <Row key={i.id} item={i} />
            ))}
          </ul>
        </section>
      ))}

      {pantry.length > 0 && (
        <section>
          <button className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-muted" onClick={() => setShowPantry(!showPantry)}>
            {showPantry ? "▾" : "▸"} {tr("À vérifier au garde-manger", "Check the pantry")} ({pantry.filter((p) => !p.checked).length})
          </button>
          {showPantry && (
            <ul className="card divide-y divide-line">
              {pantry.map((i) => (
                <Row key={i.id} item={i} />
              ))}
            </ul>
          )}
        </section>
      )}

      {items.some((i) => i.checked) && (
        <button className="btn-ghost w-full" onClick={clearChecked}>
          {tr("Retirer les articles cochés", "Remove checked items")}
        </button>
      )}
    </div>
  );
}
