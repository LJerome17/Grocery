// Load the starter recipes (public/starter/recipes.json, built by scripts/build-starter.ts) into a household.

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

export async function importStarterRecipes(householdId: string, onProgress?: (done: number, total: number) => void): Promise<number> {
  const sb = supabase();
  const [starter, catalog, existing] = await Promise.all([
    fetch("/starter/recipes.json").then((r) => r.json() as Promise<StarterRecipe[]>),
    sb.from("ingredients").select("id,name").is("household_id", null),
    sb.from("recipes").select("title").eq("household_id", householdId),
  ]);
  if (catalog.error) throw catalog.error;
  const idByName = new Map((catalog.data ?? []).map((i) => [i.name as string, i.id as string]));
  const have = new Set((existing.data ?? []).map((r) => r.title as string));
  const todo = starter.filter((r) => !have.has(r.title));

  let done = 0;
  for (const r of todo) {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- slug is only a file name, not a column
    const { ingredients, slug, ...recipe } = r;
    const { data, error } = await sb
      .from("recipes")
      .insert({ ...recipe, household_id: householdId })
      .select("id")
      .single();
    if (error) throw error;
    const rows = ingredients.map(({ catalog: cat, ...i }) => ({ ...i, recipe_id: data.id, ingredient_id: cat ? idByName.get(cat) ?? null : null }));
    if (rows.length) {
      const res = await sb.from("recipe_ingredients").insert(rows);
      if (res.error) throw res.error;
    }
    onProgress?.(++done, todo.length);
  }
  return done;
}
