// Report how each imported ingredient name maps to the catalogue.
// Usage: npx tsx scripts/check-catalog.ts [--all]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAliasIndex, matchIngredient } from "../src/lib/catalog";
import type { ImportedRecipe } from "../src/lib/importRecipe";

const ROOT = join(__dirname, "..");
const catalog = JSON.parse(readFileSync(join(ROOT, "data", "catalog.json"), "utf8")) as {
  ingredients: { name: string; aliases: string[] }[];
};
const recipes = JSON.parse(readFileSync(join(ROOT, "data", "recipes.raw.json"), "utf8")) as ImportedRecipe[];

const index = buildAliasIndex(catalog.ingredients.map((i) => ({ id: i.name, aliases: i.aliases })));
const seen = new Map<string, string | null>();
for (const r of recipes) for (const i of r.ingredients) seen.set(i.name, matchIngredient(i.name, index));

const unmatched = [...seen].filter(([, m]) => !m);
if (process.argv.includes("--all")) {
  for (const [n, m] of [...seen].sort((a, b) => (a[1] ?? "").localeCompare(b[1] ?? ""))) console.log(`${(m ?? "???").padEnd(36)} <- ${n}`);
}
console.log(`\n${seen.size} noms, ${seen.size - unmatched.length} associés, ${unmatched.length} sans correspondance`);
for (const [n] of unmatched) console.log(`  ??? ${n}`);
