// Copy of the recipe book (every recipe, its ingredients, steps and uploaded pictures) into backup/, kept in GitHub.
// The book is readable by any visitor, so the public key is enough: no secret involved.
// Run every week by .github/workflows/sauvegarde.yml, or by hand: npx tsx scripts/backup-recipes.ts
import { createClient } from "@supabase/supabase-js";
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SUPABASE_KEY, SUPABASE_URL } from "../src/lib/supabase";

const OUT = join(__dirname, "..", "backup");
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });

function must<T>(r: { data: T | null; error: { message: string } | null }): T {
  if (r.error) throw new Error(r.error.message);
  return r.data as T;
}

async function main() {
  must(await sb.auth.signInAnonymously());
  const recipes = must(await sb.from("recipes").select("*").order("title")) as Record<string, unknown>[];
  if (recipes.length < 60) throw new Error(`Seulement ${recipes.length} recettes lues : sauvegarde annulée pour ne pas écraser la précédente.`);
  const ingredients: Record<string, unknown>[] = [];
  for (let from = 0; ; from += 1000) {
    const rows = must(await sb.from("recipe_ingredients").select("*, ingredients(name, aisle)").order("recipe_id").order("position").range(from, from + 999)) as Record<string, unknown>[];
    ingredients.push(...rows);
    if (rows.length < 1000) break;
  }
  const byRecipe = new Map<unknown, Record<string, unknown>[]>();
  for (const { ingredients: cat, ...i } of ingredients) {
    const c = cat as { name: string; aisle: string } | null;
    const list = byRecipe.get(i.recipe_id) ?? [];
    list.push({ ...i, catalog: c?.name ?? null, aisle: c?.aisle ?? null });
    byRecipe.set(i.recipe_id, list);
  }

  // Pictures uploaded in the app (storage:recipe-images/...): the site's own starter pictures are already in GitHub.
  mkdirSync(join(OUT, "images"), { recursive: true });
  const keep = new Set<string>();
  for (const r of recipes) {
    const url = r.image_url as string | null;
    if (!url?.startsWith("storage:recipe-images/")) continue;
    const path = url.slice("storage:recipe-images/".length);
    const file = path.replace(/\//g, "_");
    keep.add(file);
    if (existsSync(join(OUT, "images", file))) continue;
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/public/recipe-images/${path}`);
    if (res.ok) writeFileSync(join(OUT, "images", file), Buffer.from(await res.arrayBuffer()));
    else console.log(`Photo introuvable : ${r.title}`);
  }
  for (const f of readdirSync(join(OUT, "images"))) if (!keep.has(f)) rmSync(join(OUT, "images", f));

  const book = recipes.map((r) => ({ ...r, ingredients: byRecipe.get(r.id) ?? [] }));
  writeFileSync(join(OUT, "recettes.json"), JSON.stringify(book, null, 1) + "\n");
  const own = recipes.filter((r) => !r.starter_slug).length;
  console.log(`${recipes.length} recettes sauvegardées (dont ${own} ajoutées dans l'application), ${keep.size} photos -> backup/`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
