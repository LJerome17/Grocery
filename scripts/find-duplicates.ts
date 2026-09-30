// Flag pairs of recipes whose catalogue ingredients overlap a lot (possible duplicates across sources).
// Usage: npx tsx scripts/find-duplicates.ts [threshold=0.55]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAliasIndex, matchIngredient } from "../src/lib/catalog";
import type { Entry } from "./import-local";

const ROOT = join(__dirname, "..");
const threshold = Number(process.argv[2] ?? 0.55);
const catalog = JSON.parse(readFileSync(join(ROOT, "data", "catalog.json"), "utf8")) as {
  ingredients: { name: string; pantry?: boolean; aliases: string[] }[];
};
const pantry = new Set(catalog.ingredients.filter((i) => i.pantry).map((i) => i.name));
const index = buildAliasIndex(catalog.ingredients.map((i) => ({ id: i.name, aliases: i.aliases })));
const recipes = (JSON.parse(readFileSync(join(ROOT, "data", "recipes.raw.json"), "utf8")) as Entry[]).filter((r) => !r.error);

// Compare on perishable ingredients only: salt, oil and spices say little about the dish.
const sets = recipes.map((r) => new Set(r.ingredients.map((i) => matchIngredient(i.name, index)).filter((m): m is string => !!m && !pantry.has(m))));
for (let a = 0; a < recipes.length; a++) {
  for (let b = a + 1; b < recipes.length; b++) {
    const inter = [...sets[a]].filter((x) => sets[b].has(x)).length;
    const union = new Set([...sets[a], ...sets[b]]).size;
    const j = union ? inter / union : 0;
    if (j >= threshold) console.log(`${j.toFixed(2)}  ${recipes[a].title}  <->  ${recipes[b].title}`);
  }
}
