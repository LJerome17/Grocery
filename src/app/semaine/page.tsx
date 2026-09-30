"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/components/AppProvider";
import { RecipeImage } from "@/components/RecipeImage";
import { loadHistory, toPlannerRecipes } from "@/lib/data";
import { DISH_TYPES, type WeekPlanRecipe } from "@/lib/db";
import {
  assignMultipliers,
  NOT_A_MEAL,
  passesFilters,
  planWeek,
  respectsRules,
  SEASON_LABEL,
  seasonOf,
  swapInPlan,
  weekStart,
  type Filters,
  type Planned,
  type Season,
} from "@/lib/planner";
import { formatPrice } from "@/lib/flyer";
import { dealsByIngredient, useDeals } from "@/lib/useDeals";
import { nameKey } from "@/lib/text";
import { useKitchen } from "@/lib/useKitchen";
import { generateList, loadWeek, saveWeek, servingsOf, type WeekSettings } from "@/lib/weekPlan";
import { messageFr } from "@/lib/erreur";

const ALL_SEASONS = Object.keys(SEASON_LABEL) as Season[];

function Stepper(props: { label: string; value: number; min: number; max: number; disabled: boolean; onChange: (v: number) => void }) {
  const { label, value, min, max, disabled, onChange } = props;
  return (
    <div className="flex flex-1 flex-col items-center gap-1">
      <span className="text-xs text-muted">{label}</span>
      <div className="flex items-center gap-2">
        <button className="btn-ghost h-9 w-9 !p-0 text-lg" disabled={disabled || value <= min} onClick={() => onChange(value - 1)} aria-label={`Diminuer : ${label}`}>
          −
        </button>
        <span className="w-7 text-center text-lg font-semibold">{value}</span>
        <button className="btn-ghost h-9 w-9 !p-0 text-lg" disabled={disabled || value >= max} onClick={() => onChange(value + 1)} aria-label={`Augmenter : ${label}`}>
          +
        </button>
      </div>
    </div>
  );
}

function frenchWeek(week: string) {
  return new Date(`${week}T12:00:00`).toLocaleDateString("fr-CA", { day: "numeric", month: "long" });
}

const plural = (n: number, word: string) => `${n} ${word}${Math.abs(n) > 1 ? "s" : ""}`;

export default function Semaine() {
  const { household, householdId } = useApp();
  const router = useRouter();
  const kitchen = useKitchen(householdId);
  const [offset, setOffset] = useState(0); // 0 = this week, 1 = next week
  const [today] = useState(() => new Date());
  // Calendar arithmetic (not milliseconds) so daylight-saving changes never land on the wrong week.
  const week = useMemo(() => weekStart(new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset * 7)), [today, offset]);
  const weekRef = useRef(week);
  const [loadingWeek, setLoadingWeek] = useState(true);
  const season = seasonOf(new Date(`${week}T12:00:00`));

  const [settings, setSettings] = useState<WeekSettings>({ portions: 20, recipes: 5, seasons: [season], excludeDishTypes: [] });
  const [items, setItems] = useState<WeekPlanRecipe[]>([]);
  const [planId, setPlanId] = useState<string | null>(null);
  const [history, setHistory] = useState<Map<string, number>>(new Map());
  const [swappedAway, setSwappedAway] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!householdId) return;
    let cancelled = false;
    weekRef.current = week;
    // Never show (and let people edit) the previous week's recipes while the new week loads.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset on week change
    setLoadingWeek(true);
    setItems([]);
    setPlanId(null);
    Promise.all([loadWeek(householdId, week), loadHistory(householdId, week)])
      .then(([w, h]) => {
        if (cancelled) return;
        setLoadingWeek(false);
        setPlanId(w.plan?.id ?? null);
        setItems(w.items);
        setSettings(
          w.plan
            ? {
                portions: w.plan.portions ?? 20,
                recipes: w.plan.suppers,
                seasons: w.plan.seasons ?? [seasonOf(new Date(`${week}T12:00:00`))],
                excludeDishTypes: w.plan.exclude_dish_types ?? [],
              }
            : { portions: 20, recipes: 5, seasons: [seasonOf(new Date(`${week}T12:00:00`))], excludeDishTypes: [] },
        );
        setHistory(h);
        setSwappedAway([]);
      })
      .catch((e) => {
        if (cancelled) return;
        setLoadingWeek(false);
        setError(messageFr(e));
      });
    return () => {
      cancelled = true;
    };
  }, [householdId, week]);

  // Maxi flyer valid on the week's Monday; ingredients on sale push their recipes up in the suggestions.
  const flyer = useDeals(household?.postal_code ?? "H4C 0B8", week);
  const dealMap = useMemo(() => dealsByIngredient(flyer.deals), [flyer.deals]);
  const onSale = useMemo(() => new Set(kitchen.catalog.filter((c) => dealMap.has(c.name)).map((c) => c.id)), [kitchen.catalog, dealMap]);
  const usedIngredients = useMemo(() => new Set(kitchen.ingredients.map((i) => i.ingredient_id)), [kitchen.ingredients]);
  const relevantDeals = useMemo(
    () =>
      [...dealMap.values()]
        .filter((d) => kitchen.catalog.some((c) => c.name === d.ingredient && !c.pantry && usedIngredients.has(c.id)))
        .sort((a, b) => a.ingredient.localeCompare(b.ingredient, "fr")),
    [dealMap, kitchen.catalog, usedIngredients],
  );
  const [showDeals, setShowDeals] = useState(false);

  const planner = useMemo(
    () => toPlannerRecipes(kitchen.recipes, kitchen.ingredients, kitchen.catalog, history, onSale),
    [kitchen, history, onSale],
  );
  const dealCountOf = useMemo(() => new Map(planner.map((p) => [p.id, p.dealCount ?? 0])), [planner]);
  const recipeById = useMemo(() => new Map(kitchen.recipes.map((r) => [r.id, r])), [kitchen.recipes]);
  const sv = (id: string) => servingsOf(recipeById.get(id));
  const rules = household
    ? { maxSameDishType: household.max_same_dish_type, maxSameProtein: household.max_same_protein, cooldownWeeks: household.repeat_cooldown_weeks }
    : { maxSameDishType: 1, maxSameProtein: 2, cooldownWeeks: 3 };
  const filters: Filters = { seasons: settings.seasons, excludeDishTypes: settings.excludeDishTypes };
  const current: Planned[] = items.map((i) => ({ id: i.recipe_id, multiplier: i.multiplier || 1 }));
  const available = planner.filter((r) => r.active !== false && !NOT_A_MEAL.has(r.dishType ?? "") && passesFilters(r, filters)).length;

  async function persist(planned: Planned[], s = settings) {
    const forWeek = week;
    setBusy(true);
    setError(null);
    try {
      const saved = await saveWeek(householdId, forWeek, s, planned, sv);
      // The week may have been switched while saving: never show one week's recipes under another.
      if (weekRef.current === forWeek) {
        setPlanId(saved.plan.id);
        setItems(saved.items);
      }
    } catch (e) {
      setError(messageFr(e));
    }
    setBusy(false);
  }

  /** Recompute the multipliers so the week still reaches the portions asked. */
  const refit = (ids: string[], portions: number): Planned[] => {
    const m = assignMultipliers(ids.map(sv), portions);
    return ids.map((id, i) => ({ id, multiplier: m[i] }));
  };

  function suggestAll(s = settings) {
    const plan = planWeek(planner, s.recipes, s.portions, rules, season, { filters: { seasons: s.seasons, excludeDishTypes: s.excludeDishTypes } });
    if (!plan.length) return setError("Aucune recette ne correspond aux catégories choisies.");
    return persist(plan, s);
  }

  async function changeSettings(next: WeekSettings) {
    setSettings(next);
    if (!current.length) return;
    if (next.recipes !== settings.recipes || next.portions !== settings.portions) {
      // Keep the chosen recipes (in order) as far as possible; the planner adds, drops or multiplies
      // so the week reaches the portions with the least extra.
      const plan = planWeek(planner, next.recipes, next.portions, rules, season, {
        keep: current.map((p) => p.id),
        filters: { seasons: next.seasons, excludeDishTypes: next.excludeDishTypes },
      });
      return persist(plan.length ? plan : refit(current.map((p) => p.id), next.portions), next);
    }
    return persist(current, next); // filters only: saved for the next suggestions
  }

  async function swap(recipeId: string) {
    const next = swapInPlan(planner, current, recipeId, settings.portions, rules, season, { avoid: swappedAway, filters });
    if (!next) return setError("Aucune autre recette ne convient aux catégories et aux règles de variété.");
    setSwappedAway([...swappedAway, recipeId]);
    await persist(next);
  }

  const remove = (recipeId: string) => persist(refit(current.filter((p) => p.id !== recipeId).map((p) => p.id), settings.portions));

  async function add(recipeId: string) {
    if (busy) return;
    setPicker(false);
    const ids = [...current.map((p) => p.id), recipeId];
    const s = { ...settings, recipes: Math.max(settings.recipes, ids.length) };
    setSettings(s);
    await persist(refit(ids, s.portions), s);
  }

  const setMultiplier = (recipeId: string, multiplier: number) =>
    persist(current.map((p) => (p.id === recipeId ? { ...p, multiplier: Math.max(1, multiplier) } : p)));

  async function makeList() {
    if (!planId) return;
    setBusy(true);
    try {
      await generateList(planId, items, kitchen.recipes, kitchen.ingredients, kitchen.catalog);
      router.push(`/liste?plan=${planId}`);
    } catch (e) {
      setError(messageFr(e));
      setBusy(false);
    }
  }

  const planned = current.reduce((sum, p) => sum + p.multiplier * sv(p.id), 0);
  const diff = planned - settings.portions;
  const pickable = kitchen.recipes.filter(
    (r) => !current.some((p) => p.id === r.id) && r.active && !NOT_A_MEAL.has(r.dish_type ?? "") && nameKey(r.title).includes(nameKey(search)),
  );
  const dishTypes = DISH_TYPES.filter((d) => !NOT_A_MEAL.has(d) && kitchen.recipes.some((r) => r.dish_type === d));
  const toggle = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);

  if (kitchen.loading) return <p className="py-20 text-center text-muted">Chargement…</p>;
  if (!kitchen.recipes.length) {
    return (
      <div className="card mt-10 space-y-3 p-5 text-center">
        <p>Votre foyer n&apos;a encore aucune recette.</p>
        <Link href="/recettes/nouvelle" className="btn-primary">
          Ajouter une recette
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Semaine du {frenchWeek(week)}</h1>
          <p className="text-sm text-muted">{SEASON_LABEL[season]}</p>
        </div>
        <div className="flex gap-1">
          <button className={offset === 0 ? "chip-on" : "chip"} disabled={busy} onClick={() => setOffset(0)}>
            Cette semaine
          </button>
          <button className={offset === 1 ? "chip-on" : "chip"} disabled={busy} onClick={() => setOffset(1)}>
            Suivante
          </button>
        </div>
      </header>

      <section className="card space-y-3 p-4">
        <div className="flex gap-2">
          <Stepper label="Portions" value={settings.portions} min={1} max={80} disabled={busy} onChange={(v) => changeSettings({ ...settings, portions: v })} />
          <Stepper label="Recettes (au plus)" value={settings.recipes} min={1} max={10} disabled={busy} onChange={(v) => changeSettings({ ...settings, recipes: v })} />
        </div>
        <button className="flex w-full items-center justify-between border-t border-line pt-3 text-sm" onClick={() => setShowFilters(!showFilters)}>
          <span className="font-medium">Catégories proposées</span>
          <span className="text-muted">
            {settings.seasons.map((s) => SEASON_LABEL[s as Season]).join(", ") || "Aucune saison cochée : toutes"}
            {settings.excludeDishTypes.length ? ` · sans : ${settings.excludeDishTypes.join(", ")}` : ""} {showFilters ? "▾" : "▸"}
          </span>
        </button>
        {showFilters && (
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-xs text-muted">Seules les recettes marquées pour au moins une des saisons cochées sont proposées</p>
              <div className="flex flex-wrap gap-2">
                {ALL_SEASONS.map((s) => (
                  <button key={s} disabled={busy} className={settings.seasons.includes(s) ? "chip-on" : "chip"} onClick={() => changeSettings({ ...settings, seasons: toggle(settings.seasons, s) })}>
                    {SEASON_LABEL[s]}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1 text-xs text-muted">Types de plats à éviter cette semaine</p>
              <div className="flex flex-wrap gap-2">
                {dishTypes.map((d) => (
                  <button
                    key={d}
                    disabled={busy}
                    className={settings.excludeDishTypes.includes(d) ? "chip border-red-300 bg-red-50 text-red-800 line-through" : "chip"}
                    onClick={() => changeSettings({ ...settings, excludeDishTypes: toggle(settings.excludeDishTypes, d) })}
                  >
                    {d}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-xs text-muted">{available === 0 ? "Aucune recette ne correspond" : available === 1 ? "1 recette correspond" : `${available} recettes correspondent`} à ces catégories.</p>
          </div>
        )}
      </section>

      {relevantDeals.length > 0 && (
        <section className="card p-4">
          <button className="flex w-full items-center justify-between text-sm" onClick={() => setShowDeals(!showDeals)}>
            <span className="font-medium">🏷️ Rabais Maxi qui touchent vos recettes ({relevantDeals.length})</span>
            <span className="text-muted">{showDeals ? "▾" : "▸"}</span>
          </button>
          {showDeals && (
            <ul className="mt-3 space-y-1.5 text-sm">
              {relevantDeals.map((d) => (
                  <li key={d.ingredient} className="flex justify-between gap-3">
                    <span>
                      <span className="font-medium">{d.ingredient}</span>
                      <span className="block text-xs text-muted">{d.item.toLowerCase()}</span>
                    </span>
                    <span className="shrink-0 font-semibold text-accent">{formatPrice(d.price)}</span>
                  </li>
                ))}
              {flyer.validFrom && (
                <li className="pt-1 text-xs text-muted">
                  Circulaire valide du {frenchWeek(flyer.validFrom)} au {frenchWeek(flyer.validTo!)}. Les suggestions favorisent ces recettes.
                </li>
              )}
            </ul>
          )}
        </section>
      )}

      {error && <p className="text-sm text-red-700">{error}</p>}

      {!loadingWeek && current.length > 0 && !respectsRules(current, planner, rules) && (
        <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          Variété assouplie : pas assez de recettes différentes dans ces catégories pour respecter toutes les règles de variété.
        </p>
      )}
      {!available && !loadingWeek && (
        <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          Aucune recette ne correspond aux catégories choisies : cochez une saison ou retirez un type de plat exclu.
        </p>
      )}

      {loadingWeek ? (
        <p className="py-6 text-center text-sm text-muted">Chargement de la semaine…</p>
      ) : !items.length ? (
        <button className="btn-primary w-full py-4 text-base" onClick={() => suggestAll()} disabled={busy || !available}>
          ✨ Proposer une semaine de {settings.portions} portions
        </button>
      ) : (
        <>
          <p className={`text-sm ${diff < 0 ? "font-semibold text-red-700" : "text-muted"}`}>
            {plural(planned, "portion")} prévue{planned > 1 ? "s" : ""} pour {settings.portions} demandée{settings.portions > 1 ? "s" : ""}
            {diff > 0 ? ` · ${plural(diff, "portion")} de plus` : diff < 0 ? ` · il manque ${plural(-diff, "portion")}` : " · exactement le compte"}
          </p>
          <section className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-2">
            {items.map((it) => {
              const r = recipeById.get(it.recipe_id);
              if (!r) return null;
              const m = it.multiplier || 1;
              return (
                <article key={it.id} className="card w-60 shrink-0 snap-start overflow-hidden">
                  <Link href={`/recettes/${r.id}${m > 1 ? `?fois=${m}` : ""}`}>
                    <RecipeImage url={r.image_url} title={r.title} className="h-36 w-full" />
                    <div className="space-y-1 p-3">
                      <h3 className="line-clamp-2 min-h-10 text-sm font-semibold leading-5">{r.title}</h3>
                      <p className="text-xs text-muted">
                        {m > 1 ? `${sv(r.id)} × ${m} = ${plural(sv(r.id) * m, "portion")}` : plural(sv(r.id), "portion")}
                        {r.dish_type ? ` · ${r.dish_type}` : ""}
                      </p>
                      {(dealCountOf.get(r.id) ?? 0) > 0 && (
                        <p className="text-xs font-medium text-accent">🏷️ {plural(dealCountOf.get(r.id)!, "ingrédient")} en rabais</p>
                      )}
                    </div>
                  </Link>
                  <div className="flex items-center justify-between px-3 pb-2 text-sm">
                    <span className="text-xs text-muted">Multiplier la recette</span>
                    <div className="flex items-center gap-2">
                      <button className="btn-ghost h-7 w-7 !p-0" disabled={busy || m <= 1} onClick={() => setMultiplier(r.id, m - 1)} aria-label="Diminuer">
                        −
                      </button>
                      <span className="w-4 text-center font-semibold">{m}</span>
                      <button className="btn-ghost h-7 w-7 !p-0" disabled={busy || m >= 6} onClick={() => setMultiplier(r.id, m + 1)} aria-label="Augmenter">
                        +
                      </button>
                    </div>
                  </div>
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
            <button className="btn-ghost flex-1" onClick={() => suggestAll()} disabled={busy}>
              ✨ Proposer une autre semaine
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
                    <span className="flex-1 text-sm font-medium">{r.title}</span>
                    <span className="pr-3 text-xs text-muted">{plural(servingsOf(r), "portion")}</span>
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
