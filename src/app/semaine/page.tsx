"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "@/components/AppProvider";
import { RecipeImage } from "@/components/RecipeImage";
import { loadHistory, toPlannerRecipes } from "@/lib/data";
import { DISH_TYPES, dishTypeLabel, type WeekPlanRecipe } from "@/lib/db";
import {
  fitMultipliers,
  NOT_A_MEAL,
  passesFilters,
  planWeek,
  respectsRules,
  SEASON_LABEL,
  seasonLabel,
  seasonOf,
  swapInPlan,
  weekStart,
  type Filters,
  type Planned,
  type Season,
} from "@/lib/planner";
import { nameKey } from "@/lib/text";
import { useKitchen } from "@/lib/useKitchen";
import { fixedOf, flagsOf, generateList, listStatus, loadWeek, postponeRecipe, saveWeek, servingsOf, type WeekSettings } from "@/lib/weekPlan";
import { messageFr } from "@/lib/erreur";
import { locale, plural, tr } from "@/lib/i18n";

const ALL_SEASONS = Object.keys(SEASON_LABEL) as Season[];

function Stepper(props: { label: string; value: number; min: number; max: number; disabled: boolean; onChange: (v: number) => void }) {
  const { label, value, min, max, disabled, onChange } = props;
  return (
    <div className="flex flex-1 flex-col items-center gap-1">
      <span className="text-xs text-muted">{label}</span>
      <div className="flex items-center gap-2">
        <button className="btn-ghost h-9 w-9 !p-0 text-lg" disabled={disabled || value <= min} onClick={() => onChange(value - 1)} aria-label={tr(`Diminuer : ${label}`, `Decrease: ${label}`)}>
          −
        </button>
        {/* Typed number, applied when leaving the field (or Enter), so each keystroke does not replan the week. */}
        <input
          key={value}
          className="w-12 rounded-lg border border-line bg-card py-1 text-center text-lg font-semibold [appearance:textfield] focus:border-brand focus:outline-none [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          defaultValue={value}
          disabled={disabled}
          aria-label={label}
          onFocus={(e) => e.target.select()}
          onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
          onBlur={(e) => {
            const n = Math.round(Number(e.target.value));
            if (!Number.isFinite(n) || e.target.value === "") e.target.value = String(value);
            else if (Math.min(max, Math.max(min, n)) !== value) onChange(Math.min(max, Math.max(min, n)));
            else e.target.value = String(value);
          }}
        />
        <button className="btn-ghost h-9 w-9 !p-0 text-lg" disabled={disabled || value >= max} onClick={() => onChange(value + 1)} aria-label={tr(`Augmenter : ${label}`, `Increase: ${label}`)}>
          +
        </button>
      </div>
    </div>
  );
}

function frenchWeek(week: string) {
  return new Date(`${week}T12:00:00`).toLocaleDateString(locale(), { day: "numeric", month: "long" });
}

const portions = (n: number) => plural(n, ["portion", "portions"], ["serving", "servings"]);

export default function Semaine() {
  const { household, householdId } = useApp();
  const router = useRouter();
  const kitchen = useKitchen(householdId);
  const [offset, setOffset] = useState(0); // 0 = this week, 1 = next week
  // From the list's "Semaine suivante": /semaine?semaine=suivante opens next week.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- read the link once on arrival
    if (new URLSearchParams(window.location.search).get("semaine") === "suivante") setOffset(1);
  }, []);
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
  const [postponing, setPostponing] = useState<string | null>(null);
  const [showFilters, setShowFilters] = useState(false);
  const [search, setSearch] = useState("");
  /** Whether the week's stored list still matches its recipes (recipes changed since "Faire la liste"). */
  const [list, setList] = useState<"none" | "current" | "stale">("none");

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

  const planner = useMemo(
    () => toPlannerRecipes(kitchen.recipes, kitchen.ingredients, kitchen.catalog, history),
    [kitchen, history],
  );
  const recipeById = useMemo(() => new Map(kitchen.recipes.map((r) => [r.id, r])), [kitchen.recipes]);
  const sv = (id: string) => servingsOf(recipeById.get(id));
  const rules = household
    ? { maxSameDishType: household.max_same_dish_type, maxSameProtein: household.max_same_protein, cooldownWeeks: household.repeat_cooldown_weeks }
    : { maxSameDishType: 1, maxSameProtein: 2, cooldownWeeks: 3 };
  const filters: Filters = { seasons: settings.seasons, excludeDishTypes: settings.excludeDishTypes };
  const current: Planned[] = items.map((i) => ({ id: i.recipe_id, multiplier: i.multiplier || 1 }));
  // Postponed recipes keep their multiplier (their groceries may already be bought): the planner works around them.
  const fixed = fixedOf(items);
  const fixedList = [...fixed].map(([id, multiplier]) => ({ id, multiplier }));

  // The list is checked against the recipes after every change (and on arrival), also when the other phone changed it.
  useEffect(() => {
    if (!planId || kitchen.loading) return;
    let cancelled = false;
    listStatus(planId, items, kitchen.recipes, kitchen.ingredients, kitchen.catalog).then(
      (s) => !cancelled && setList(s),
      () => {},
    );
    return () => {
      cancelled = true;
    };
  }, [planId, items, kitchen.loading, kitchen.recipes, kitchen.ingredients, kitchen.catalog]);
  const available = planner.filter((r) => r.active !== false && !NOT_A_MEAL.has(r.dishType ?? "") && passesFilters(r, filters)).length;

  async function persist(planned: Planned[], s = settings, flags = flagsOf(items)) {
    const forWeek = week;
    setBusy(true);
    setError(null);
    try {
      const saved = await saveWeek(householdId, forWeek, s, planned, sv, flags);
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

  /** Recompute the multipliers so the week still reaches the portions asked (postponed recipes keep theirs). */
  const refit = (ids: string[], portions: number): Planned[] => fitMultipliers(ids, sv, portions, fixed);

  function suggestAll(s = settings) {
    // Recipes postponed from the previous week stay, with their multiplier; the suggestions fill the rest.
    const plan = planWeek(planner, s.recipes, s.portions, rules, season, { fixed: fixedList, filters: { seasons: s.seasons, excludeDishTypes: s.excludeDishTypes } });
    if (!plan.length) return setError(tr("Aucune recette ne correspond aux catégories choisies.", "No recipe matches the chosen categories."));
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
        fixed: fixedList,
        filters: { seasons: next.seasons, excludeDishTypes: next.excludeDishTypes },
      });
      return persist(plan.length ? plan : refit(current.map((p) => p.id), next.portions), next);
    }
    return persist(current, next); // filters only: saved for the next suggestions
  }

  async function swap(recipeId: string) {
    const next = swapInPlan(planner, current, recipeId, settings.portions, rules, season, { avoid: swappedAway, filters, fixed });
    if (!next) return setError(tr("Aucune autre recette ne convient aux catégories et aux règles de variété.", "No other recipe fits the categories and variety rules."));
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

  /**
   * Move a recipe to the following week. Its multiplier stays (the groceries may already be bought for it) and the
   * other recipes of this week are left as they are: no recipe is multiplied to make up for it.
   */
  async function postpone(recipeId: string, bought: boolean) {
    setPostponing(null);
    if (!current.some((p) => p.id === recipeId) || busy) return;
    const forWeek = week;
    setBusy(true);
    setError(null);
    try {
      // Both weeks in one save: the recipe is never in both, or in neither.
      const r = await postponeRecipe(householdId, { week, settings, planned: current, flags: flagsOf(items) }, recipeId, bought, settings, sv);
      if (r === "already") setError(tr("Cette recette est déjà prévue la semaine suivante.", "This recipe is already planned for the next week."));
      else if (weekRef.current === forWeek) {
        setPlanId(r.from.plan.id);
        setItems(r.from.items);
      }
    } catch (e) {
      setError(messageFr(e));
    }
    setBusy(false);
  }

  /** Put a postponed recipe's ingredients back on the list (or take them off again). */
  async function setBought(recipeId: string, bought: boolean) {
    const flags = flagsOf(items);
    flags.set(recipeId, { ...flags.get(recipeId), already_bought: bought });
    await persist(current, settings, flags);
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

  if (kitchen.loading) return <p className="py-20 text-center text-muted">{tr("Chargement…", "Loading…")}</p>;
  if (!kitchen.recipes.length) {
    return (
      <div className="card mt-10 space-y-3 p-5 text-center">
        <p>{tr("Aucune recette pour l'instant.", "No recipes yet.")}</p>
        {household?.is_book && (
          <Link href="/recettes/nouvelle" className="btn-primary">
            {tr("Ajouter une recette", "Add a recipe")}
          </Link>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{tr(`Semaine du ${frenchWeek(week)}`, `Week of ${frenchWeek(week)}`)}</h1>
          <p className="text-sm text-muted">{household ? `${household.name} · ` : ""}{seasonLabel(season)}</p>
        </div>
        <div className="flex gap-1">
          <button className={offset === 0 ? "chip-on" : "chip"} disabled={busy} onClick={() => setOffset(0)}>
            {tr("Cette semaine", "This week")}
          </button>
          <button className={offset === 1 ? "chip-on" : "chip"} disabled={busy} onClick={() => setOffset(1)}>
            {tr("Semaine suivante", "Next week")}
          </button>
        </div>
      </header>

      <section className="card space-y-3 p-4">
        <div className="flex gap-2">
          <Stepper label={tr("Portions", "Servings")} value={settings.portions} min={1} max={80} disabled={busy} onChange={(v) => changeSettings({ ...settings, portions: v })} />
          <Stepper label={tr("Recettes (au plus)", "Recipes (max)")} value={settings.recipes} min={Math.max(1, fixed.size)} max={10} disabled={busy} onChange={(v) => changeSettings({ ...settings, recipes: v })} />
        </div>
        <button className="flex w-full items-center justify-between border-t border-line pt-3 text-sm" onClick={() => setShowFilters(!showFilters)}>
          <span className="font-medium">{tr("Catégories proposées", "Suggested categories")}</span>
          <span className="text-muted">
            {settings.seasons.map((s) => seasonLabel(s as Season)).join(", ") || tr("Aucune saison cochée : toutes", "No season checked: all")}
            {settings.excludeDishTypes.length ? tr(` · sans : ${settings.excludeDishTypes.map(dishTypeLabel).join(", ")}`, ` · without: ${settings.excludeDishTypes.map(dishTypeLabel).join(", ")}`) : ""} {showFilters ? "▾" : "▸"}
          </span>
        </button>
        {showFilters && (
          <div className="space-y-3">
            <div>
              <p className="mb-1 text-xs text-muted">{tr("Seules les recettes marquées pour au moins une des saisons cochées sont proposées", "Only recipes marked for at least one of the checked seasons are suggested")}</p>
              <div className="flex flex-wrap gap-2">
                {ALL_SEASONS.map((s) => (
                  <button key={s} disabled={busy} className={settings.seasons.includes(s) ? "chip-on" : "chip"} onClick={() => changeSettings({ ...settings, seasons: toggle(settings.seasons, s) })}>
                    {seasonLabel(s)}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <p className="mb-1 text-xs text-muted">{tr("Types de plats à éviter cette semaine", "Dish types to avoid this week")}</p>
              <div className="flex flex-wrap gap-2">
                {dishTypes.map((d) => (
                  <button
                    key={d}
                    disabled={busy}
                    className={settings.excludeDishTypes.includes(d) ? "chip border-red-300 bg-red-50 text-red-800 line-through" : "chip"}
                    onClick={() => changeSettings({ ...settings, excludeDishTypes: toggle(settings.excludeDishTypes, d) })}
                  >
                    {dishTypeLabel(d)}
                  </button>
                ))}
              </div>
            </div>
            <p className="text-xs text-muted">{tr(`${available === 0 ? "Aucune recette ne correspond" : available === 1 ? "1 recette correspond" : `${available} recettes correspondent`} à ces catégories.`, `${available === 0 ? "No recipes match" : available === 1 ? "1 recipe matches" : `${available} recipes match`} these categories.`)}</p>
          </div>
        )}
      </section>

      {error && <p className="text-sm text-red-700">{error}</p>}

      {!loadingWeek && current.length > 0 && !respectsRules(current, planner, rules) && (
        <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          {tr("Variété assouplie : pas assez de recettes différentes dans ces catégories pour respecter toutes les règles de variété.", "Variety relaxed: not enough different recipes in these categories to follow every variety rule.")}
        </p>
      )}
      {!available && !loadingWeek && (
        <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          {tr("Aucune recette ne correspond aux catégories choisies : cochez une saison ou retirez un type de plat exclu.", "No recipe matches the chosen categories: check a season or remove an excluded dish type.")}
        </p>
      )}

      {loadingWeek ? (
        <p className="py-6 text-center text-sm text-muted">{tr("Chargement de la semaine…", "Loading the week…")}</p>
      ) : !items.length ? (
        <div className="space-y-2">
          <button className="btn-primary w-full py-4 text-base" onClick={() => suggestAll()} disabled={busy || !available}>
            ✨ {tr(`Proposer une semaine de ${settings.portions} portions`, `Suggest a week of ${settings.portions} servings`)}
          </button>
          <button className="btn-ghost w-full" onClick={() => setPicker(true)} disabled={busy}>
            ＋ {tr("Choisir une recette", "Pick a recipe")}
          </button>
        </div>
      ) : (
        <>
          <p className={`text-sm ${diff < 0 ? "font-semibold text-red-700" : "text-muted"}`}>
            {tr(`${portions(planned)} prévue${planned > 1 ? "s" : ""} pour ${settings.portions} demandée${settings.portions > 1 ? "s" : ""}`, `${portions(planned)} planned for ${settings.portions} requested`)}
            {diff > 0 ? tr(` · ${portions(diff)} de plus`, ` · ${portions(diff)} extra`) : diff < 0 ? tr(` · il manque ${portions(-diff)}`, ` · ${portions(-diff)} short`) : tr(" · exactement le compte", " · exactly right")}
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
                        {m > 1 ? `${sv(r.id)} × ${m} = ${portions(sv(r.id) * m)}` : portions(sv(r.id))}
                        {r.dish_type ? ` · ${dishTypeLabel(r.dish_type)}` : ""}
                      </p>
                    </div>
                  </Link>
                  {it.postponed && (
                    <div className="mx-3 mb-2 rounded-lg bg-brand-soft px-2 py-1 text-xs">
                      <p className="font-medium">
                        ⏭ {it.already_bought ? tr("Reportée · ingrédients déjà achetés", "Postponed · ingredients already bought") : tr("Reportée · sur la liste", "Postponed · on the list")}
                      </p>
                      <button className="text-muted underline" disabled={busy} onClick={() => setBought(r.id, !it.already_bought)}>
                        {it.already_bought ? tr("Mettre ses ingrédients sur la liste", "Put its ingredients on the list") : tr("Retirer ses ingrédients de la liste", "Take its ingredients off the list")}
                      </button>
                    </div>
                  )}
                  <div className="flex items-center justify-between px-3 pb-2 text-sm">
                    <span className="text-xs text-muted">{tr("Multiplier la recette", "Multiply the recipe")}</span>
                    <div className="flex items-center gap-2">
                      <button className="btn-ghost h-7 w-7 !p-0" disabled={busy || m <= 1} onClick={() => setMultiplier(r.id, m - 1)} aria-label={tr("Diminuer", "Decrease")}>
                        −
                      </button>
                      <span className="w-4 text-center font-semibold">{m}</span>
                      <button className="btn-ghost h-7 w-7 !p-0" disabled={busy || m >= 6} onClick={() => setMultiplier(r.id, m + 1)} aria-label={tr("Augmenter", "Increase")}>
                        +
                      </button>
                    </div>
                  </div>
                  <div className="flex gap-2 px-3 pb-3">
                    <button className="btn-ghost flex-1 !py-2" onClick={() => swap(r.id)} disabled={busy}>
                      🔄 {tr("Échanger", "Swap")}
                    </button>
                    {offset === 0 && (
                      <button className="btn-ghost !px-3 !py-2" onClick={() => setPostponing(r.id)} disabled={busy} aria-label={tr("Reporter à la semaine suivante", "Postpone to next week")} title={tr("Reporter à la semaine suivante", "Postpone to next week")}>
                        ⏭
                      </button>
                    )}
                    <button className="btn-ghost !px-3 !py-2" onClick={() => remove(r.id)} disabled={busy} aria-label={tr("Retirer", "Remove")}>
                      ✕
                    </button>
                  </div>
                </article>
              );
            })}
            <button className="card flex w-40 shrink-0 flex-col items-center justify-center gap-2 text-muted" onClick={() => setPicker(true)} disabled={busy}>
              <span className="text-3xl">＋</span>
              <span className="text-sm">{tr("Ajouter", "Add")}</span>
            </button>
          </section>

          {list === "stale" && (
            <div className="flex items-center justify-between gap-3 rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
              <span>{tr("La liste d'épicerie n'est plus à jour : les recettes ont changé depuis.", "The grocery list is out of date: the recipes changed since.")}</span>
              <button className="btn-primary shrink-0 !py-2" onClick={makeList} disabled={busy}>
                {tr("Refaire la liste", "Remake the list")}
              </button>
            </div>
          )}
          <div className="flex gap-2">
            <button className="btn-ghost flex-1" onClick={() => suggestAll()} disabled={busy}>
              ✨ {tr("Proposer une autre semaine", "Suggest another week")}
            </button>
            <button className="btn-primary flex-1" onClick={makeList} disabled={busy}>
              🛒 {tr("Faire la liste", "Make the list")}
            </button>
          </div>
        </>
      )}

      {postponing && (
        <div className="fixed inset-0 z-30 flex items-end bg-black/40" onClick={() => setPostponing(null)}>
          <div className="w-full space-y-3 rounded-t-3xl bg-background p-5" onClick={(e) => e.stopPropagation()}>
            <h2 className="font-semibold">{tr(`Reporter « ${recipeById.get(postponing)?.title ?? ""} » à la semaine suivante`, `Postpone “${recipeById.get(postponing)?.title ?? ""}” to next week`)}</h2>
            <p className="text-sm text-muted">{tr("Ses ingrédients sont-ils déjà achetés ?", "Are its ingredients already bought?")}</p>
            <button className="btn-primary w-full" onClick={() => postpone(postponing, true)}>
              {tr("Oui : ne pas les remettre sur la liste", "Yes: keep them off the list")}
            </button>
            <button className="btn-ghost w-full" onClick={() => postpone(postponing, false)}>
              {tr("Non : les mettre sur la liste de la semaine suivante", "No: put them on next week's list")}
            </button>
            <button className="w-full text-sm text-muted underline" onClick={() => setPostponing(null)}>
              {tr("Annuler", "Cancel")}
            </button>
          </div>
        </div>
      )}

      {picker && (
        <div className="fixed inset-0 z-30 flex items-end bg-black/40" onClick={() => setPicker(false)}>
          <div className="max-h-[80vh] w-full overflow-y-auto rounded-t-3xl bg-background p-4" onClick={(e) => e.stopPropagation()}>
            <input className="input mb-3" placeholder={tr("Chercher une recette…", "Search for a recipe…")} autoFocus value={search} onChange={(e) => setSearch(e.target.value)} />
            <ul className="space-y-2">
              {pickable.map((r) => (
                <li key={r.id}>
                  <button className="card flex w-full items-center gap-3 overflow-hidden text-left" onClick={() => add(r.id)}>
                    <RecipeImage url={r.image_url} title={r.title} className="h-14 w-16 shrink-0" />
                    <span className="flex-1 text-sm font-medium">{r.title}</span>
                    <span className="pr-3 text-xs text-muted">{portions(servingsOf(r))}</span>
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
