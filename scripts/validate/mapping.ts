// List every starter-recipe ingredient line with its catalogue item, aisle and pantry flag.
// Usage: npx tsx scripts/validate/mapping.ts [--catalog]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAliasIndex, matchIngredient } from "../../src/lib/catalog";

const ROOT = join(__dirname, "..", "..");
type Item = { name: string; aisle: string; pantry?: boolean; aliases: string[] };
const catalog = JSON.parse(readFileSync(join(ROOT, "data", "catalog.json"), "utf8")) as { ingredients: Item[] };
const recipes = JSON.parse(readFileSync(join(ROOT, "public", "starter", "recipes.json"), "utf8")) as {
  slug: string;
  ingredients: { raw: string; name: string; catalog: string | null; optional: boolean }[];
}[];
const byName = new Map(catalog.ingredients.map((i) => [i.name, i]));
const index = buildAliasIndex(catalog.ingredients.map((i) => ({ id: i.name, aliases: i.aliases })));

if (process.argv.includes("--catalog")) {
  for (const i of catalog.ingredients) console.log(`${i.name} | ${i.aisle} | pantry=${!!i.pantry} | ${i.aliases.join(", ")}`);
  process.exit(0);
}
let n = 0;
for (const r of recipes)
  for (const l of r.ingredients) {
    n++;
    const it = l.catalog ? byName.get(l.catalog) : undefined;
    const live = matchIngredient(l.name, index);
    const flag = !l.catalog ? "NULL" : !it ? "UNKNOWN" : live !== l.catalog ? `LIVE=${live}` : "";
    console.log(`${r.slug} | ${l.raw} | name=${l.name} -> ${l.catalog ?? "-"} | ${it?.aisle ?? "-"} | ${it?.pantry ? "P" : ""} ${flag}`);
  }
console.log(`\n${n} lignes, ${recipes.length} recettes`);
