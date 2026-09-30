// The "Momo et Jéjé" starter recipes (public/starter/recipes.json, built by scripts/build-starter.ts).
// Each one has a stable `slug`, stored in recipes.starter_slug; households.starter_seen lists the slugs a
// household already received, so a recipe it deleted is never added back.

import { supabase } from "./supabase";

type StarterRecipe = {
  slug: string;
  title: string;
  source_type: string;
  source_url: string | null;
  image_url: string | null;
  servings: number | null;
  total_minutes: number | null;
  instructions: string[];
  dish_type: string | null;
  protein: string | null;
  seasons: string[];
  ingredients: {
    position: number;
    section: string | null;
    raw: string;
    quantity: number | null;
    quantity_max: number | null;
    unit: string | null;
    name: string;
    note: string | null;
    optional: boolean;
    catalog: string | null;
  }[];
};

type Mine = { id: string; title: string; source_url: string | null; starter_slug: string | null };

async function loadContext(householdId: string) {
  const sb = supabase();
  const [starter, catalog, existing, household] = await Promise.all([
    fetch("/starter/recipes.json", { cache: "no-store" }).then((r) => r.json() as Promise<StarterRecipe[]>),
    sb.from("ingredients").select("id,name").is("household_id", null),
    sb.from("recipes").select("id,title,source_url,starter_slug").eq("household_id", householdId),
    sb.from("households").select("starter_seen").eq("id", householdId).single(),
  ]);
  if (catalog.error) throw catalog.error;
  if (existing.error) throw existing.error;
  if (household.error) throw household.error;
  const idByName = new Map((catalog.data ?? []).map((i) => [i.name as string, i.id as string]));
  const rowsFor = (r: StarterRecipe, recipeId: string) =>
    r.ingredients.map(({ catalog: cat, ...i }) => ({ ...i, recipe_id: recipeId, ingredient_id: cat ? idByName.get(cat) ?? null : null }));
  return { starter, mine: (existing.data ?? []) as Mine[], seen: new Set((household.data?.starter_seen as string[] | null) ?? []), rowsFor };
}

async function markSeen(householdId: string, seen: Set<string>) {
  const { error } = await supabase().from("households").update({ starter_seen: [...seen] }).eq("id", householdId);
  if (error) throw error;
}

/** Add the starter recipes this household never received (new household, or new recipes in a later version). */
export async function importStarterRecipes(householdId: string, onProgress?: (done: number, total: number) => void): Promise<number> {
  const sb = supabase();
  const { starter, mine, seen, rowsFor } = await loadContext(householdId);
  const have = new Set(mine.map((m) => m.starter_slug ?? ""));
  const todo = starter.filter((r) => !seen.has(r.slug) && !have.has(r.slug));

  let done = 0;
  for (const r of todo) {
    const { ingredients: _ingredients, slug, ...recipe } = r; // eslint-disable-line @typescript-eslint/no-unused-vars
    const { data, error } = await sb
      .from("recipes")
      .insert({ ...recipe, household_id: householdId, starter_slug: slug })
      .select("id")
      .single();
    if (error) throw error;
    const rows = rowsFor(r, data.id);
    if (rows.length) {
      const res = await sb.from("recipe_ingredients").insert(rows);
      if (res.error) throw res.error;
    }
    seen.add(slug);
    onProgress?.(++done, todo.length);
  }
  for (const r of starter) if (have.has(r.slug)) seen.add(r.slug);
  await markSeen(householdId, seen);
  return done;
}

/**
 * Apply the latest corrections (ingredient lines, steps, original link) to the household's starter recipes,
 * matched by their starter id (never by title), and add genuinely new starter recipes. The household's
 * choices (seasons, rating, dish type, protein, portions, active) and its own recipes are left alone.
 */
export async function syncStarterRecipes(householdId: string, onProgress?: (done: number, total: number) => void): Promise<{ updated: number; added: number }> {
  const sb = supabase();
  const { starter, mine, rowsFor } = await loadContext(householdId);
  const bySlug = new Map(mine.filter((m) => m.starter_slug).map((m) => [m.starter_slug!, m]));
  const toUpdate = starter.filter((r) => bySlug.has(r.slug));

  let done = 0;
  for (const r of toUpdate) {
    const recipe = bySlug.get(r.slug)!;
    // New lines first, then remove the old ones: an interruption never leaves a recipe without ingredients.
    const old = await sb.from("recipe_ingredients").select("id").eq("recipe_id", recipe.id);
    if (old.error) throw old.error;
    const rows = rowsFor(r, recipe.id);
    if (rows.length) {
      const ins = await sb.from("recipe_ingredients").insert(rows);
      if (ins.error) throw ins.error;
    }
    const oldIds = (old.data ?? []).map((o) => o.id as string);
    if (oldIds.length) {
      const del = await sb.from("recipe_ingredients").delete().in("id", oldIds);
      if (del.error) throw del.error;
    }
    const upd = await sb
      .from("recipes")
      .update({ instructions: r.instructions, ...(recipe.source_url ? {} : { source_url: r.source_url }) })
      .eq("id", recipe.id);
    if (upd.error) throw upd.error;
    onProgress?.(++done, toUpdate.length);
  }
  const added = await importStarterRecipes(householdId);
  return { updated: toUpdate.length, added };
}
