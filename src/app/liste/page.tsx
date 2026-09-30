"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/AppProvider";
import { AISLE_LABEL, AISLE_ORDER } from "@/lib/aisles";
import type { ShoppingItem } from "@/lib/db";
import { weekStart } from "@/lib/planner";
import { supabase } from "@/lib/supabase";

export default function Liste() {
  const { householdId } = useApp();
  const [planId, setPlanId] = useState<string | null>(null);
  const [items, setItems] = useState<ShoppingItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [newItem, setNewItem] = useState("");
  const [hideChecked, setHideChecked] = useState(false);
  const [showPantry, setShowPantry] = useState(false);

  const load = useCallback(async () => {
    if (!householdId) return;
    // Most recent plan that has a list (this week, else next week, else the latest one).
    const { data: plans } = await supabase()
      .from("week_plans")
      .select("id, week_start")
      .eq("household_id", householdId)
      .order("week_start", { ascending: false })
      .limit(4);
    const thisWeek = weekStart(new Date());
    const ordered = (plans ?? []).sort((a, b) => Number(b.week_start >= thisWeek) - Number(a.week_start >= thisWeek));
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
  }, [householdId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    load();
  }, [load]);

  // Live sync: a box ticked on one phone shows up on the other.
  useEffect(() => {
    if (!planId) return;
    const channel = supabase()
      .channel(`liste-${planId}`)
      .on("postgres_changes", { event: "*", schema: "public", table: "shopping_items", filter: `plan_id=eq.${planId}` }, (payload) => {
        setItems((prev) => {
          if (payload.eventType === "DELETE") return prev.filter((i) => i.id !== (payload.old as ShoppingItem).id);
          const row = payload.new as ShoppingItem;
          return prev.some((i) => i.id === row.id) ? prev.map((i) => (i.id === row.id ? row : i)) : [...prev, row];
        });
      })
      .subscribe();
    return () => {
      supabase().removeChannel(channel);
    };
  }, [planId]);

  async function toggle(item: ShoppingItem) {
    setItems((prev) => prev.map((i) => (i.id === item.id ? { ...i, checked: !i.checked } : i)));
    await supabase().from("shopping_items").update({ checked: !item.checked }).eq("id", item.id);
  }

  async function addItem(e: React.FormEvent) {
    e.preventDefault();
    const label = newItem.trim();
    if (!label || !planId) return;
    setNewItem("");
    const { data } = await supabase()
      .from("shopping_items")
      .insert({ plan_id: planId, label, aisle: "autre", manual: true, position: 9999 })
      .select("*")
      .single();
    if (data) setItems((prev) => (prev.some((i) => i.id === data.id) ? prev : [...prev, data as ShoppingItem]));
  }

  async function removeItem(item: ShoppingItem) {
    setItems((prev) => prev.filter((i) => i.id !== item.id));
    await supabase().from("shopping_items").delete().eq("id", item.id);
  }

  async function clearChecked() {
    const ids = items.filter((i) => i.checked).map((i) => i.id);
    setItems((prev) => prev.filter((i) => !i.checked));
    if (ids.length) await supabase().from("shopping_items").delete().in("id", ids);
  }

  const groups = useMemo(() => {
    const shown = items.filter((i) => !i.pantry && !(hideChecked && i.checked));
    const byAisle = new Map<string, ShoppingItem[]>();
    for (const i of shown) byAisle.set(i.aisle, [...(byAisle.get(i.aisle) ?? []), i]);
    return [...byAisle].sort((a, b) => (AISLE_ORDER[a[0]] ?? 99) - (AISLE_ORDER[b[0]] ?? 99));
  }, [items, hideChecked]);
  const pantry = items.filter((i) => i.pantry);
  const remaining = items.filter((i) => !i.pantry && !i.checked).length;

  if (loading) return <p className="py-20 text-center text-muted">Chargement…</p>;

  if (!planId) {
    return (
      <div className="card mt-10 space-y-3 p-5 text-center">
        <p>Pas encore de liste. Choisissez d&apos;abord les recettes de la semaine.</p>
        <Link href="/semaine" className="btn-primary">
          Planifier la semaine
        </Link>
      </div>
    );
  }

  const Row = ({ item }: { item: ShoppingItem }) => (
    <li className="flex items-center gap-3 px-4 py-3">
      <button
        onClick={() => toggle(item)}
        className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border-2 ${item.checked ? "border-brand bg-brand text-white" : "border-line"}`}
        aria-label={item.checked ? "Décocher" : "Cocher"}
      >
        {item.checked && "✓"}
      </button>
      <button onClick={() => toggle(item)} className={`flex-1 text-left ${item.checked ? "text-muted line-through" : ""}`}>
        <span className="font-medium">{item.label}</span>
        {item.quantity_text && <span className="ml-2 text-sm text-muted">{item.quantity_text}</span>}
      </button>
      {item.manual && (
        <button onClick={() => removeItem(item)} className="text-muted" aria-label="Supprimer">
          ✕
        </button>
      )}
    </li>
  );

  return (
    <div className="space-y-4">
      <header className="flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-bold">Épicerie</h1>
          <p className="text-sm text-muted">{remaining} article{remaining > 1 ? "s" : ""} à acheter</p>
        </div>
        <button className={hideChecked ? "chip-on" : "chip"} onClick={() => setHideChecked(!hideChecked)}>
          {hideChecked ? "Tout afficher" : "Cacher les cochés"}
        </button>
      </header>

      <form onSubmit={addItem} className="flex gap-2">
        <input className="input" placeholder="Ajouter un article (papier de toilette…)" value={newItem} onChange={(e) => setNewItem(e.target.value)} />
        <button className="btn-primary" aria-label="Ajouter">
          ＋
        </button>
      </form>

      {groups.map(([aisle, list]) => (
        <section key={aisle}>
          <h2 className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-muted">{AISLE_LABEL[aisle] ?? "Autre"}</h2>
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
            {showPantry ? "▾" : "▸"} À vérifier au garde-manger ({pantry.filter((p) => !p.checked).length})
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
          Retirer les articles cochés
        </button>
      )}
    </div>
  );
}
