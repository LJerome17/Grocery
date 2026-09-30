// Proteins actually present in each recipe (from its catalogue ingredients) vs the category recorded.
// Usage: npx tsx scripts/protein-audit.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(__dirname, "..");
const recipes = JSON.parse(readFileSync(join(ROOT, "public", "starter", "recipes.json"), "utf8")) as {
  title: string;
  protein: string | null;
  ingredients: { catalog: string | null; optional: boolean; section: string | null; raw: string }[];
}[];

/** Catalogue item -> protein category (finer than "légumineuses", as the user asked). */
export const PROTEIN_OF: [RegExp, string][] = [
  [/^Tofu/, "tofu"],
  [/^Tempeh/, "tempeh"],
  [/^Haché végé/, "haché végé"],
  [/^Pois chiches/, "pois chiches"],
  [/^Haricots noirs/, "haricots noirs"],
  [/^Haricots rouges/, "haricots rouges"],
  [/^Haricots blancs/, "haricots blancs"],
  [/^Haricots pinto/, "haricots pinto"],
  [/^Lentilles/, "lentilles"],
  [/^Édamames/, "édamames"],
  [/^(Halloumi|Feta|Fromage de chèvre|Cheddar|Mozzarella|Parmesan$)/, "fromage"],
  [/^Œufs/, "œufs"],
  [/^Hauts de cuisse de poulet/, "poulet"],
  [/^Thon/, "poisson"],
];

for (const r of recipes) {
  const found = new Map<string, number>();
  for (const i of r.ingredients) {
    if (!i.catalog || i.optional) continue;
    const p = PROTEIN_OF.find(([re]) => re.test(i.catalog!))?.[1];
    if (p) found.set(p, (found.get(p) ?? 0) + 1);
  }
  const list = [...found.keys()];
  const flag = !list.length ? "(aucune)" : list.includes(r.protein ?? "") ? "" : " ⚠";
  console.log(`${(r.protein ?? "-").padEnd(13)} | ${list.join(", ").padEnd(40)} | ${r.title}${flag}`);
}
