"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/AppProvider";
import { RecipeImage } from "@/components/RecipeImage";
import { loadHistory, toPlannerRecipes } from "@/lib/data";
import type { WeekPlanRecipe } from "@/lib/db";
import { NOT_A_MEAL, portionsPerRecipe, SEASON_LABEL, seasonOf, suggest, swapFor, weekStart } from "@/lib/planner";
import { useKitchen } from "@/lib/useKitchen";
import { generateList, loadWeek, saveWeek } from "@/lib/weekPlan";

function Stepper({
  label,
  value,
  min,
  max,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center gap-1">
      <span className="text-xs text-muted">{label}</span>
      <div className="flex items-center gap-2">
        <button className="btn-ghost h-9 w-9 !p-0 text-lg" disabled={disabled || value <= min} onClick={() => onChange(value - 1)} aria-label={`Moins de ${label}`}>
          −
        </button>
        <span className="w-6 text-center text-lg font-semibold">{value}</span>
        <button className="btn-ghost h-9 w-9 !p-0 text-lg" disabled={disabled || value >= max} onClick={() => onChange(value + 1)} aria-label={`Plus de ${label}`}>
          +
        </button>
      </div>
    </div>
  );
}

function frenchWeek(week: string) {
  const d = new Date(`${week}T12:00:00`);
  return d.toLocaleDateString("fr-CA", { day: "numeric", month: "long" });
}

export default function Semaine() {
  const { household, householdId } = useApp();
  const router = useRouter();
  const kitchen = useKitchen(householdId);
  const [offset, setOffset] = useState(0); // 0 = this week, 1 = next week
  const [today] = useState(() => new Date());
  const week = useMemo(() => weekStart(new Date(today.getTime() + offset * 7 * 864e5)), [today, offset]);
  const season = seasonOf(new Date(`${week}T12:00:00`));

  const [settings, setSettings] = useState({ suppers: 5, people: 2, lunches: 2 });
  const [items, setItems] = useState<WeekPlanRecipe[]>([]);
  const [planId, setPlanId] = useState<string | null>(null);
  const [history, setHistory] = useState<Map<string, number>>(new Map());
  const [swappedAway, setSwappedAway] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!householdId) return;
    let cancelled = false;
    Promise.all([loadWeek(householdId, week), loadHistory(householdId, week)])
      .then(([w, h]) => {
        if (cancelled) return;
        setPlanId(w.plan?.id ?? null);
        setItems(w.items);
        if (w.plan) setSettings({ suppers: w.plan.suppers, people: w.plan.people, lunches: w.plan.lunches });
        setHistory(h);
        setSwappedAway([]);
      })
      .catch((e) => setError(String(e.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [householdId, week]);

  const planner = useMemo(() => toPlannerRecipes(kitchen.recipes, kitchen.ingredients, kitchen.catalog, history), [kitchen, history]);
  const recipeById = useMemo(() => new Map(kitchen.recipes.map((r) => [r.id, r])), [kitchen.recipes]);
  const rules = household
    ? { maxSameDishType: household.max_same_dish_type, maxSameProtein: household.max_same_protein, cooldownWeeks: household.repeat_cooldown_weeks }
    : { maxSameDishType: 1, maxSameProtein: 2, cooldownWeeks: 3 };
  const ids = items.map((i) => i.recipe_id);

  async function persist(recipeIds: string[], s = settings) {
    setBusy(true);
    setError(null);
    try {
      const saved = await saveWeek(householdId, week, s, recipeIds);
      setPlanId(saved.plan.id);
      setItems(saved.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  const suggestAll = () => persist(suggest(planner, settings.suppers, rules, season));

  async function changeSettings(next: typeof settings) {
    setSettings(next);
    if (!ids.length) return;
    // Keep the chosen recipes; add or drop at the end to match the number of suppers.
    const kept = ids.slice(0, next.suppers);
    const full = kept.length < next.suppers ? suggest(planner, next.suppers, rules, season, { keep: kept }) : kept;
    await persist(full, next);
  }

  async function swap(recipeId: string) {
    const next = swapFor(planner, ids, recipeId, rules, season, { avoid: swappedAway });
    if (!next) return setError("Aucune autre recette ne respecte les règles de variété.");
    setSwappedAway([...swappedAway, recipeId]);
    await persist(ids.map((id) => (id === recipeId ? next : id)));
  }

  async function remove(recipeId: string) {
    const next = ids.filter((id) => id !== recipeId);
    const s = { ...settings, suppers: Math.max(1, next.length) };
    setSettings(s);
    await persist(next, s);
  }

  async function add(recipeId: string) {
    if (busy) return;
    setPicker(false);
    const next = [...ids, recipeId];
    const s = { ...settings, suppers: next.length };
    setSettings(s);
    await persist(next, s);
  }

  async function makeList() {
    if (!planId) return;
    setBusy(true);
    try {
      await generateList(planId, items, kitchen.recipes, kitchen.ingredients, kitchen.catalog);
      router.push(`/liste?plan=${planId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const portions = portionsPerRecipe(items.length, settings.people, settings.lunches);
  const pickable = kitchen.recipes.filter(
    (r) => !ids.includes(r.id) && r.active && !NOT_A_MEAL.has(r.dish_type ?? "") && r.title.toLowerCase().includes(search.toLowerCase()),
  );

  if (kitchen.loading) return <p className="py-20 text-center text-muted">Chargement…</p>;

  if (!kitchen.recipes.length) {
    return (
      <div className="card mt-10 space-y-3 p-5 text-center">
        <p>Aucune recette pour l&apos;instant.</p>
        <Link href="/foyer" className="btn-primary">
          Importer les recettes de départ
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Semaine du {frenchWeek(week)}</h1>
          <p className="text-sm text-muted">
            {SEASON_LABEL[season]} · {kitchen.recipes.length} recettes
          </p>
        </div>
        <div className="flex gap-1">
          <button className={offset === 0 ? "chip-on" : "chip"} onClick={() => setOffset(0)}>
            Cette sem.
          </button>
          <button className={offset === 1 ? "chip-on" : "chip"} onClick={() => setOffset(1)}>
            Prochaine
          </button>
        </div>
      </header>

      <section className="card flex gap-2 p-4">
        <Stepper label="Soupers" value={settings.suppers} min={1} max={7} disabled={busy} onChange={(v) => changeSettings({ ...settings, suppers: v })} />
        <Stepper label="Personnes" value={settings.people} min={1} max={8} disabled={busy} onChange={(v) => changeSettings({ ...settings, people: v })} />
        <Stepper label="Lunchs" value={settings.lunches} min={0} max={14} disabled={busy} onChange={(v) => changeSettings({ ...settings, lunches: v })} />
      </section>

      {error && <p className="text-sm text-red-700">{error}</p>}

      {!items.length ? (
        <button className="btn-primary w-full py-4 text-base" onClick={suggestAll} disabled={busy}>
          ✨ Suggérer {settings.suppers} soupers
        </button>
      ) : (
        <>
          <section className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2">
            {items.map((it, i) => {
              const r = recipeById.get(it.recipe_id);
              if (!r) return null;
              return (
                <article key={it.id} className="card w-60 shrink-0 snap-start overflow-hidden">
                  <Link href={`/recettes/${r.id}?portions=${portions[i] ?? it.portions}`}>
                    <RecipeImage url={r.image_url} title={r.title} className="h-36 w-full" />
                    <div className="space-y-1 p-3">
                      <h3 className="line-clamp-2 min-h-10 text-sm font-semibold leading-5">{r.title}</h3>
                      <p className="text-xs text-muted">
                        {portions[i] ?? it.portions} portions{r.dish_type ? ` · ${r.dish_type}` : ""}
                        {r.protein ? ` · ${r.protein}` : ""}
                      </p>
                    </div>
                  </Link>
                  <div className="flex gap-2 px-3 pb-3">
                    <button className="btn-ghost flex-1 !py-2" onClick={() => swap(r.id)} disabled={busy}>
                      🔄 Échanger
                    </button>
                    <button className="btn-ghost !px-3 !py-2" onClick={() => remove(r.id)} disabled={busy} aria-label="Retirer">
                      ✕
                    </button>
                  </div>
                </article>
              );
            })}
            <button className="card flex w-40 shrink-0 flex-col items-center justify-center gap-2 text-muted" onClick={() => setPicker(true)} disabled={busy}>
              <span className="text-3xl">＋</span>
              <span className="text-sm">Ajouter</span>
            </button>
          </section>

          <div className="flex gap-2">
            <button className="btn-ghost flex-1" onClick={suggestAll} disabled={busy}>
              ✨ Tout re-suggérer
            </button>
            <button className="btn-primary flex-1" onClick={makeList} disabled={busy}>
              🛒 Faire la liste
            </button>
          </div>
        </>
      )}

      {picker && (
        <div className="fixed inset-0 z-30 flex items-end bg-black/40" onClick={() => setPicker(false)}>
          <div className="max-h-[80vh] w-full overflow-y-auto rounded-t-3xl bg-background p-4" onClick={(e) => e.stopPropagation()}>
            <input className="input mb-3" placeholder="Chercher une recette…" autoFocus value={search} onChange={(e) => setSearch(e.target.value)} />
            <ul className="space-y-2">
              {pickable.map((r) => (
                <li key={r.id}>
                  <button className="card flex w-full items-center gap-3 overflow-hidden text-left" onClick={() => add(r.id)}>
                    <RecipeImage url={r.image_url} title={r.title} className="h-14 w-16 shrink-0" />
                    <span className="text-sm font-medium">{r.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </div>
  );
}
