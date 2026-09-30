// Week plan persistence and grocery list generation.

import { NO_AISLE } from "./aisles";
import type { Ingredient, Recipe, RecipeIngredient, WeekPlan, WeekPlanRecipe } from "./db";
import { portionsPerRecipe } from "./planner";
import { buildShoppingList, scaleFactor, type CatalogItem } from "./shopping";
import { supabase } from "./supabase";

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

export async function saveWeek(
  householdId: string,
  week: string,
  settings: { suppers: number; people: number; lunches: number },
  recipeIds: string[],
): Promise<{ plan: WeekPlan; items: WeekPlanRecipe[] }> {
  const sb = supabase();
  const { data: plan, error } = await sb
    .from("week_plans")
    .upsert({ household_id: householdId, week_start: week, ...settings }, { onConflict: "household_id,week_start" })
    .select("*")
    .single();
  if (error) throw error;
  const portions = portionsPerRecipe(recipeIds.length, settings.people, settings.lunches);
  const del = await sb.from("week_plan_recipes").delete().eq("plan_id", plan.id);
  if (del.error) throw del.error;
  const rows = recipeIds.map((recipe_id, position) => ({ plan_id: plan.id, recipe_id, position, portions: portions[position] }));
  const { data: items, error: e2 } = rows.length ? await sb.from("week_plan_recipes").insert(rows).select("*") : { data: [], error: null };
  if (e2) throw e2;
  return { plan: plan as WeekPlan, items: ((items ?? []) as WeekPlanRecipe[]).sort((a, b) => a.position - b.position) };
}

/** Replace the generated lines of the plan's list (manual additions are kept). Returns the number of lines. */
export async function generateList(
  planId: string,
  items: WeekPlanRecipe[],
  recipes: Recipe[],
  ingredients: RecipeIngredient[],
  catalog: Ingredient[],
): Promise<number> {
  const byRecipe = new Map<string, RecipeIngredient[]>();
  for (const i of ingredients) byRecipe.set(i.recipe_id, [...(byRecipe.get(i.recipe_id) ?? []), i]);
  const recipeById = new Map(recipes.map((r) => [r.id, r]));
  const cat = new Map<string, CatalogItem>(catalog.map((c) => [c.id, c]));

  const lines = buildShoppingList(
    items
      .map((it) => ({ it, r: recipeById.get(it.recipe_id) }))
      .filter((x): x is { it: WeekPlanRecipe; r: Recipe } => !!x.r)
      .map(({ it, r }) => ({ title: r.title, factor: scaleFactor(it.portions, r.servings), ingredients: byRecipe.get(r.id) ?? [] })),
    cat,
  ).filter((l) => l.aisle !== NO_AISLE);

  const sb = supabase();
  const del = await sb.from("shopping_items").delete().eq("plan_id", planId).eq("manual", false);
  if (del.error) throw del.error;
  const rows = lines.map((l, position) => ({
    plan_id: planId,
    ingredient_id: l.ingredientId,
    label: l.optional ? `${l.label} (facultatif)` : l.label,
    quantity_text: l.quantityText,
    aisle: l.aisle,
    pantry: l.pantry,
    manual: false,
    checked: false,
    position,
  }));
  if (rows.length) {
    const res = await sb.from("shopping_items").insert(rows);
    if (res.error) throw res.error;
  }
  return rows.length;
}
