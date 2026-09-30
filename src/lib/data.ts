// Data access shared by the pages (row-level security limits everything to the user's household).

import { buildAliasIndex, type AliasIndex } from "./catalog";
import { RECIPE_COLUMNS, type Ingredient, type Recipe, type RecipeIngredient } from "./db";
import type { PlannerRecipe } from "./planner";
import { supabase } from "./supabase";

/** The household's own recipes and the Momo et Jéjé book (row-level security returns exactly those). */
export async function loadRecipes(): Promise<Recipe[]> {
  const { data, error } = await supabase().from("recipes").select(RECIPE_COLUMNS).order("title");
  if (error) throw error;
  return (data ?? []) as Recipe[];
}

export async function loadRecipeIngredients(recipeIds: string[]): Promise<RecipeIngredient[]> {
  if (!recipeIds.length) return [];
  const out: RecipeIngredient[] = [];
  // Page through: PostgREST caps responses at 1000 rows.
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase()
      .from("recipe_ingredients")
      .select("*")
      .in("recipe_id", recipeIds)
      .order("recipe_id")
      .order("position")
      .range(from, from + 999);
    if (error) throw error;
    out.push(...((data ?? []) as RecipeIngredient[]));
    if (!data || data.length < 1000) break;
  }
  return out;
}

export async function loadCatalog(): Promise<Ingredient[]> {
  const { data, error } = await supabase().from("ingredients").select("id,household_id,name,aisle,pantry,count_unit,equiv").order("name");
  if (error) throw error;
  return (data ?? []) as Ingredient[];
}

export async function loadAliasIndex(): Promise<AliasIndex> {
  const rows: { ingredient_id: string; alias: string; household_id: string | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase()
      .from("ingredient_aliases")
      .select("ingredient_id,alias,household_id")
      .order("id")
      .range(from, from + 999);
    if (error) throw error;
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  // Household aliases come last so they override the global catalogue (the last one wins in the index).
  rows.sort((a, b) => Number(a.household_id !== null) - Number(b.household_id !== null));
  return buildAliasIndex(rows.map((r) => ({ id: r.ingredient_id, aliases: [r.alias] })));
}

/** Weeks since each recipe was last planned (before `beforeWeek`). */
export async function loadHistory(householdId: string, beforeWeek: string): Promise<Map<string, number>> {
  const { data, error } = await supabase()
    .from("week_plans")
    .select("week_start, week_plan_recipes(recipe_id)")
    .eq("household_id", householdId)
    .lt("week_start", beforeWeek);
  if (error) throw error;
  const now = new Date(beforeWeek).getTime();
  const out = new Map<string, number>();
  for (const p of data ?? []) {
    const weeks = Math.round((now - new Date(p.week_start as string).getTime()) / (7 * 864e5));
    for (const r of (p.week_plan_recipes ?? []) as { recipe_id: string }[]) {
      const prev = out.get(r.recipe_id);
      if (prev === undefined || weeks < prev) out.set(r.recipe_id, weeks);
    }
  }
  return out;
}

export function toPlannerRecipes(
  recipes: Recipe[],
  ingredients: RecipeIngredient[],
  catalog: Ingredient[],
  history: Map<string, number>,
  /** Catalogue ingredient ids on sale this week. */
): PlannerRecipe[] {
  const pantry = new Set(catalog.filter((c) => c.pantry).map((c) => c.id));
  const perRecipe = new Map<string, Set<string>>();
  for (const i of ingredients) {
    if (!i.ingredient_id || pantry.has(i.ingredient_id)) continue;
    if (!perRecipe.has(i.recipe_id)) perRecipe.set(i.recipe_id, new Set());
    perRecipe.get(i.recipe_id)!.add(i.ingredient_id);
  }
  return recipes.map((r) => ({
    id: r.id,
    servings: r.servings && r.servings > 0 ? r.servings : undefined,
    dishType: r.dish_type,
    protein: r.protein,
    seasons: r.seasons,
    rating: r.rating,
    ingredientIds: [...(perRecipe.get(r.id) ?? [])],
    weeksSinceEaten: history.get(r.id) ?? null,
    active: r.active,
  }));
}
