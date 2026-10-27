// Week plan persistence and grocery list generation.

import { NO_AISLE } from "./aisles";
import type { Ingredient, Recipe, RecipeIngredient, WeekPlan, WeekPlanRecipe } from "./db";
import { DEFAULT_SERVINGS, seasonOf, weekStart, type Planned } from "./planner";
import { buildShoppingList, type CatalogItem } from "./shopping";
import { tr } from "./i18n";
import { supabase } from "./supabase";

export type WeekSettings = {
  portions: number;
  recipes: number;
  seasons: string[];
  excludeDishTypes: string[];
};

export async function loadWeek(householdId: string, week: string): Promise<{ plan: WeekPlan | null; items: WeekPlanRecipe[] }> {
  const { data: plan, error } = await supabase()
    .from("week_plans")
    .select("*")
    .eq("household_id", householdId)
    .eq("week_start", week)
    .maybeSingle();
  if (error) throw error;
  if (!plan) return { plan: null, items: [] };
  const { data: items, error: e2 } = await supabase().from("week_plan_recipes").select("*").eq("plan_id", plan.id).order("position");
  if (e2) throw e2;
  return { plan: plan as WeekPlan, items: (items ?? []) as WeekPlanRecipe[] };
}

/** One week to save: its settings, its recipes in order and their postponed / already-bought marks. */
export type WeekToSave = { week: string; settings: WeekSettings; planned: Planned[]; flags?: Map<string, PostponeFlags> };
type Saved = { plan: WeekPlan; items: WeekPlanRecipe[] };

const recipeRows = (w: WeekToSave, servingsOf: (recipeId: string) => number) =>
  w.planned.map((p, position) => ({
    recipe_id: p.id,
    position,
    multiplier: p.multiplier,
    portions: p.multiplier * servingsOf(p.id),
    postponed: !!w.flags?.get(p.id)?.postponed,
    already_bought: !!w.flags?.get(p.id)?.already_bought,
  }));

/** PostgREST's "no such function": the database has not received migration 0015 yet. */
const missingFunction = (e: { code?: string } | null) => e?.code === "PGRST202";

/**
 * Save one or more weeks of the household in a single transaction (save_weeks, migration 0015): a lost connection
 * never leaves a week half saved, and a postponed recipe is never in both weeks or in neither.
 */
export async function saveWeeks(householdId: string, weeks: WeekToSave[], servingsOf: (recipeId: string) => number): Promise<Saved[]> {
  const { data, error } = await supabase().rpc("save_weeks", {
    p_household: householdId,
    p_weeks: weeks.map((w) => ({
      week_start: w.week,
      suppers: w.settings.recipes,
      portions: w.settings.portions,
      seasons: w.settings.seasons,
      exclude_dish_types: w.settings.excludeDishTypes,
      recipes: recipeRows(w, servingsOf),
    })),
  });
  if (!error) return data as Saved[];
  if (!missingFunction(error)) throw error;
  const out: Saved[] = [];
  for (const w of weeks) out.push(await saveWeekInSteps(householdId, w, servingsOf));
  return out;
}

export async function saveWeek(
  householdId: string,
  week: string,
  settings: WeekSettings,
  planned: Planned[],
  servingsOf: (recipeId: string) => number,
  /** Postponed / already-bought marks, by recipe id (kept across the delete and re-insert). */
  flags: Map<string, PostponeFlags> = new Map(),
): Promise<Saved> {
  return (await saveWeeks(householdId, [{ week, settings, planned, flags }], servingsOf))[0];
}

/** Before migration 0015: the same save in separate requests. */
async function saveWeekInSteps(householdId: string, w: WeekToSave, servingsOf: (recipeId: string) => number): Promise<Saved> {
  const sb = supabase();
  const { data: plan, error } = await sb
    .from("week_plans")
    .upsert(
      {
        household_id: householdId,
        week_start: w.week,
        suppers: w.settings.recipes,
        portions: w.settings.portions,
        seasons: w.settings.seasons,
        exclude_dish_types: w.settings.excludeDishTypes,
      },
      { onConflict: "household_id,week_start" },
    )
    .select("*")
    .single();
  if (error) throw error;
  const del = await sb.from("week_plan_recipes").delete().eq("plan_id", plan.id);
  if (del.error) throw del.error;
  const rows = recipeRows(w, servingsOf).map(({ postponed, already_bought, ...r }) => ({
    plan_id: plan.id,
    ...r,
    // Only written when set, so weeks without a postponed recipe never need the columns.
    ...(postponed ? { postponed } : {}),
    ...(already_bought ? { already_bought } : {}),
  }));
  const { data: items, error: e2 } = rows.length
    ? await sb.from("week_plan_recipes").insert(rows, { defaultToNull: false }).select("*")
    : { data: [], error: null };
  if (e2) throw e2;
  return { plan: plan as WeekPlan, items: ((items ?? []) as WeekPlanRecipe[]).sort((a, b) => a.position - b.position) };
}

export type PostponeFlags = Pick<WeekPlanRecipe, "postponed" | "already_bought">;

/** The postponed / already-bought marks of a week's recipes, to pass back to saveWeek. */
export function flagsOf(items: WeekPlanRecipe[]): Map<string, PostponeFlags> {
  return new Map(items.filter((i) => i.postponed || i.already_bought).map((i) => [i.recipe_id, { postponed: i.postponed, already_bought: i.already_bought }]));
}

/** Postponed recipes of a week with their multiplier: the planner keeps them as they are. */
export function fixedOf(items: WeekPlanRecipe[]): Map<string, number> {
  return new Map(items.filter((i) => i.postponed).map((i) => [i.recipe_id, i.multiplier || 1]));
}

/** The Monday seven days after `week` (calendar arithmetic, safe across daylight-saving changes). */
export function nextWeekOf(week: string): string {
  const [y, m, d] = week.split("-").map(Number);
  return weekStart(new Date(y, m - 1, d + 7));
}

/**
 * Move a recipe from week `from` to the following week, in one save of both weeks. It keeps its multiplier and joins
 * the next week (created with `fallback` settings if that week has none) marked postponed, and already bought when
 * `bought`. The rest of `from` is left as it is: no recipe is multiplied to make up for it.
 * "already" when the recipe is planned in the next week already: nothing changes.
 */
export async function postponeRecipe(
  householdId: string,
  from: WeekToSave,
  recipeId: string,
  bought: boolean,
  fallback: WeekSettings,
  servingsOf: (recipeId: string) => number,
): Promise<"already" | { from: Saved; next: Saved }> {
  const moved = from.planned.find((p) => p.id === recipeId);
  if (!moved) throw new Error(`recipe not in the week: ${recipeId}`);
  const target = nextWeekOf(from.week);
  const next = await loadWeek(householdId, target);
  if (next.items.some((i) => i.recipe_id === recipeId)) return "already";
  const planned = [...next.items.map((i) => ({ id: i.recipe_id, multiplier: i.multiplier || 1 })), moved];
  const season = seasonOf(new Date(`${target}T12:00:00`));
  const base: WeekSettings = next.plan
    ? { portions: next.plan.portions ?? 20, recipes: next.plan.suppers, seasons: next.plan.seasons ?? [season], excludeDishTypes: next.plan.exclude_dish_types ?? [] }
    : { ...fallback, seasons: [season] };
  const flags = flagsOf(next.items);
  flags.set(recipeId, { postponed: true, already_bought: bought });
  const fromFlags = new Map(from.flags ?? []);
  fromFlags.delete(recipeId);
  const [savedNext, savedFrom] = await saveWeeks(
    householdId,
    [
      { week: target, settings: { ...base, recipes: Math.max(base.recipes, planned.length) }, planned, flags },
      { week: from.week, settings: from.settings, planned: from.planned.filter((p) => p.id !== recipeId), flags: fromFlags },
    ],
    servingsOf,
  );
  return { from: savedFrom, next: savedNext };
}

/** Lists to try, in order: the plan asked for, this week, upcoming weeks (soonest first), then past weeks (latest first). */
export function listOrder<P extends { id: string; week_start: string }>(plans: P[], requested: string | null, thisWeek: string): P[] {
  const rank = (w: string) => (w === thisWeek ? 0 : w > thisWeek ? 1 : 2);
  return [...plans].sort(
    (a, b) =>
      Number(b.id === requested) - Number(a.id === requested) ||
      rank(a.week_start) - rank(b.week_start) ||
      (rank(a.week_start) === 1 ? a.week_start.localeCompare(b.week_start) : b.week_start.localeCompare(a.week_start)),
  );
}

export const servingsOf = (r: Pick<Recipe, "servings"> | undefined) => (r?.servings && r.servings > 0 ? r.servings : DEFAULT_SERVINGS);

export type ListRow = { ingredient_id: string | null; label: string; quantity_text: string; aisle: string; pantry: boolean; position: number };

/** The generated lines of a week's list (manual items aside), as stored. */
export function listRows(items: WeekPlanRecipe[], recipes: Recipe[], ingredients: RecipeIngredient[], catalog: Ingredient[]): ListRow[] {
  const byRecipe = new Map<string, RecipeIngredient[]>();
  for (const i of ingredients) byRecipe.set(i.recipe_id, [...(byRecipe.get(i.recipe_id) ?? []), i]);
  const recipeById = new Map(recipes.map((r) => [r.id, r]));
  const cat = new Map<string, CatalogItem>(catalog.map((c) => [c.id, c]));

  // Quantities as written in the recipe, times the whole multiplier: never adapted otherwise.
  const lines = buildShoppingList(
    items
      // A postponed recipe whose ingredients were bought with the previous week's list.
      .filter((it) => !it.already_bought)
      .map((it) => ({ it, r: recipeById.get(it.recipe_id) }))
      .filter((x): x is { it: WeekPlanRecipe; r: Recipe } => !!x.r)
      .map(({ it, r }) => ({ title: r.title, factor: it.multiplier || 1, ingredients: byRecipe.get(r.id) ?? [] })),
    cat,
  ).filter((l) => l.aisle !== NO_AISLE);
  return lines.map((l, position) => ({
    ingredient_id: l.ingredientId,
    label: l.optional ? `${l.label} ${tr("(facultatif)", "(optional)")}` : l.label,
    quantity_text: l.quantityText,
    aisle: l.aisle,
    pantry: l.pantry,
    position,
  }));
}

/**
 * Fingerprint of a list's lines (labels and quantities, in the household's language): stored when the list is made,
 * so a later change of recipes is noticed even after bought items were removed from the list.
 */
export function listSignature(rows: Pick<ListRow, "label" | "quantity_text">[]): string {
  const text = rows.map((r) => `${r.label}|${r.quantity_text ?? ""}`).sort().join("\n");
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = (Math.imul(h, 33) ^ text.charCodeAt(i)) >>> 0;
  return `${rows.length}-${h.toString(36)}`;
}

const tickKey = (r: { ingredient_id: string | null; label: string }) => r.ingredient_id ?? `label:${r.label}`;

/**
 * Replace the generated lines of the plan's list (manual additions are kept), in one transaction (replace_list,
 * migration 0015). Someone may be at the store ticking items: what is already ticked stays ticked in the new list
 * (a ticked manual item never ticks a generated line). Returns the number of lines.
 */
export async function generateList(
  planId: string,
  items: WeekPlanRecipe[],
  recipes: Recipe[],
  ingredients: RecipeIngredient[],
  catalog: Ingredient[],
): Promise<number> {
  const rows = listRows(items, recipes, ingredients, catalog);
  const sb = supabase();
  // make_list (migration 0016) also records the list's fingerprint; replace_list (0015) does not.
  const made = await sb.rpc("make_list", { p_plan: planId, p_rows: rows, p_signature: listSignature(rows) });
  if (!made.error) return rows.length;
  if (!missingFunction(made.error)) throw made.error;
  const { error } = await sb.rpc("replace_list", { p_plan: planId, p_rows: rows });
  if (!error) return rows.length;
  if (!missingFunction(error)) throw error;

  // Before migration 0015: the same in separate requests.
  const { data: previous, error: e1 } = await sb.from("shopping_items").select("ingredient_id,label").eq("plan_id", planId).eq("checked", true).eq("manual", false);
  if (e1) throw e1;
  const ticked = new Set((previous ?? []).map(tickKey));
  const del = await sb.from("shopping_items").delete().eq("plan_id", planId).eq("manual", false);
  if (del.error) throw del.error;
  if (rows.length) {
    const res = await sb.from("shopping_items").insert(rows.map((r) => ({ ...r, plan_id: planId, manual: false, checked: ticked.has(tickKey(r)) })));
    if (res.error) throw res.error;
  }
  return rows.length;
}

/**
 * Whether the plan's stored list still matches its recipes: "none" (no list made), "current", or "stale" (recipes,
 * multipliers or the language changed since "Faire la liste").
 */
export async function listStatus(
  planId: string,
  items: WeekPlanRecipe[],
  recipes: Recipe[],
  ingredients: RecipeIngredient[],
  catalog: Ingredient[],
): Promise<"none" | "current" | "stale"> {
  // The fingerprint taken when the list was made: removing bought items from the list does not make it stale.
  const plan = await supabase().from("week_plans").select("list_signature").eq("id", planId).maybeSingle();
  const signature = plan.error ? null : (plan.data as { list_signature?: string | null } | null)?.list_signature;
  if (signature) return signature === listSignature(listRows(items, recipes, ingredients, catalog)) ? "current" : "stale";
  // Lists made before migration 0016: compare the lines themselves.
  const { data, error } = await supabase().from("shopping_items").select("label,quantity_text").eq("plan_id", planId).eq("manual", false);
  if (error) throw error;
  if (!data?.length) return "none";
  const key = (r: { label: string; quantity_text: string | null }) => `${r.label}|${r.quantity_text ?? ""}`;
  const stored = data.map(key).sort();
  const expected = listRows(items, recipes, ingredients, catalog).map(key).sort();
  return stored.length === expected.length && stored.every((k, i) => k === expected[i]) ? "current" : "stale";
}
