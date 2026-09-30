// Package the imported recipes as the app's starter set, loaded from the "Importer nos recettes" button:
//   public/starter/recipes.json   recipes + ingredients (catalogue names, resolved to ids in the app)
//   public/starter/images/*.webp  one picture per recipe
// Usage: npx tsx scripts/build-starter.ts
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildAliasIndex, matchIngredient } from "../src/lib/catalog";
import type { Entry } from "./import-local";

const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "public", "starter");
const read = <T>(f: string) => JSON.parse(readFileSync(join(ROOT, "data", f), "utf8")) as T;

const catalog = read<{ ingredients: { name: string; aliases: string[] }[] }>("catalog.json").ingredients;
const meta = read<{ recipes: Record<string, { dish_type: string; protein: string; seasons: string[] }> }>("recipe-meta.json").recipes;
const recipes = read<Entry[]>("recipes.raw.json").filter((r) => !r.error);
const index = buildAliasIndex(catalog.map((c) => ({ id: c.name, aliases: c.aliases })));
// Official pages found online for screenshot/pasted recipes: shown as "Recette originale".
const found = new Map(
  (existsSync(join(ROOT, "data", "image-search-results.json")) ? read<{ slug: string; status: string; pageUrl: string | null }[]>("image-search-results.json") : [])
    .filter((x) => x.status === "found" && x.pageUrl)
    .map((x) => [x.slug, x.pageUrl!]),
);

mkdirSync(join(OUT, "images"), { recursive: true });
const out = recipes.map((r) => {
  const img = join(ROOT, "data", "images", `${r.slug}.webp`);
  if (existsSync(img)) copyFileSync(img, join(OUT, "images", `${r.slug}.webp`));
  const m = meta[r.title];
  return {
    slug: r.slug,
    title: r.title,
    source_type: r.sourceType,
    source_url: r.sourceUrl ?? found.get(r.slug) ?? null,
    image_url: existsSync(img) ? `/starter/images/${r.slug}.webp` : null,
    servings: r.servings,
    total_minutes: r.totalMinutes,
    instructions: r.instructions,
    dish_type: m?.dish_type ?? null,
    protein: m?.protein ?? null,
    seasons: m?.seasons ?? ["printemps", "ete", "automne", "hiver"],
    ingredients: r.ingredients.map((i, position) => ({
      position,
      section: i.section,
      raw: i.raw,
      quantity: i.quantity,
      quantity_max: i.quantityMax,
      unit: i.unit,
      name: i.name,
      note: i.note,
      optional: i.optional,
      catalog: matchIngredient(i.name, index),
    })),
  };
});
writeFileSync(join(OUT, "recipes.json"), JSON.stringify(out));
console.log(`${out.length} recettes de départ -> public/starter/`);
