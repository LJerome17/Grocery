// Grocery list of every starter recipe at once, to review the wording of each line.
// Usage: npx tsx scripts/list-audit.ts [--bare]   (--bare: only lines containing a number without a unit)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildShoppingList, type CatalogItem } from "../src/lib/shopping";

const ROOT = join(__dirname, "..");
const catalog = JSON.parse(readFileSync(join(ROOT, "data", "catalog.json"), "utf8")).ingredients as {
  name: string;
  aisle: string;
  pantry?: boolean;
  count_unit?: string;
}[];
const recipes = JSON.parse(readFileSync(join(ROOT, "public", "starter", "recipes.json"), "utf8")) as {
  title: string;
  ingredients: { quantity: number | null; unit: string | null; name: string; optional: boolean; catalog: string | null; raw: string }[];
}[];
const cat = new Map<string, CatalogItem>(catalog.map((c) => [c.name, { id: c.name, name: c.name, aisle: c.aisle, pantry: !!c.pantry, count_unit: c.count_unit ?? null }]));

const lines = buildShoppingList(
  recipes.map((r) => ({ title: r.title, factor: 1, ingredients: r.ingredients.map((i) => ({ ...i, ingredient_id: i.catalog })) })),
  cat,
);
const bare = process.argv.includes("--bare");
for (const l of lines) {
  const hasBare = l.quantityText.split(" + ").some((p) => /^[\d¼½¾⅓⅔ ,]+$/.test(p.trim()));
  if (bare && !hasBare) continue;
  console.log(`${l.label} — ${l.quantityText}`);
  if (bare) {
    // Which recipe lines produce the bare number.
    for (const r of recipes)
      for (const i of r.ingredients)
        if (i.catalog === l.ingredientId && i.quantity !== null && (i.unit === null || i.unit === "piece") && !cat.get(l.ingredientId!)?.count_unit)
          console.log(`      ${i.raw}   [${r.title}]`);
  }
}
