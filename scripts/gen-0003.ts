// Generate supabase/migrations/0003_portions_filters.sql: schema for portions/multipliers/filters,
// plus the recipe corrections of 2026-09-29 applied to households that already imported the starter set.
// Usage: npx tsx scripts/gen-0003.ts
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Entry } from "./import-local";

const ROOT = join(__dirname, "..");
const recipes = JSON.parse(readFileSync(join(ROOT, "data", "recipes.raw.json"), "utf8")) as Entry[];
const fixes = JSON.parse(readFileSync(join(ROOT, "data", "import-fixes.json"), "utf8"));
const q = (v: unknown) => (v === null || v === undefined ? "null" : typeof v === "number" ? String(v) : `'${String(v).replace(/'/g, "''")}'`);
const find = (title: string) => recipes.find((r) => r.title.replace(/’/g, "'") === title.replace(/’/g, "'"))!;

const sql: string[] = [
  "-- Portions per week + whole multipliers + category filters (2026-09-29).",
  "",
  "alter table week_plans add column if not exists portions int not null default 20;",
  "alter table week_plans add column if not exists seasons text[];",
  "alter table week_plans add column if not exists exclude_dish_types text[] not null default '{}';",
  "alter table week_plan_recipes add column if not exists multiplier int not null default 1;",
  "",
  "-- New catalogue item for the tofu recipes' side vegetables.",
  "insert into ingredients (household_id, name, aisle, pantry) values (null, 'Légumes d''accompagnement (au choix)', 'fruits-legumes', false) on conflict do nothing;",
  "insert into ingredient_aliases (ingredient_id, household_id, alias) select i.id, null, a from ingredients i, unnest(array['legumes pour accompagner le tofu','legumes pour accompagner','legumes d accompagnement','legumes au choix']) a where i.household_id is null and i.name = 'Légumes d''accompagnement (au choix)' on conflict do nothing;",
  "",
  "-- Corrections for recipes already imported (matched by title in every household).",
];

const scale = Object.entries(fixes.scale).filter(([k]) => k !== "_doc") as [string, number][];
for (const [title, k] of scale) {
  // Displayed lines rewritten with the multiplied quantities (idempotent: plain assignment by position).
  const r = find(title);
  const raws = r.ingredients.map((i, n) => `when ${n} then ${q(i.raw)}`).join(" ");
  sql.push(`update recipe_ingredients set raw = case position ${raws} else raw end where recipe_id in (select id from recipes where title = ${q(title)});`);
  sql.push(
    `update recipe_ingredients set quantity = quantity * ${k}, quantity_max = quantity_max * ${k} where recipe_id in (select id from recipes where title = ${q(title)} and servings = 1);`,
    `update recipes set servings = ${k} where title = ${q(title)} and servings = 1;`,
  );
}
for (const [title, n] of Object.entries(fixes.servings).filter(([k]) => k !== "_doc") as [string, number][]) {
  const exact = find(title)?.title ?? title;
  sql.push(`update recipes set servings = ${n} where title = ${q(exact)};`);
}
for (const [title, lines] of Object.entries(fixes.addIngredients).filter(([k]) => k !== "_doc") as [string, string[]][]) {
  const r = find(title);
  for (const line of lines) {
    const ing = r.ingredients.find((i) => i.raw === line)!;
    const catalog = /légumes pour accompagner/i.test(line) ? "Légumes d'accompagnement (au choix)" : "Pâtes courtes";
    sql.push(
      `insert into recipe_ingredients (recipe_id, position, raw, quantity, unit, name, note, optional, ingredient_id) select r.id, 999, ${q(line)}, ${q(ing.quantity)}, ${q(ing.unit)}, ${q(ing.name)}, ${q(ing.note)}, false, (select id from ingredients where household_id is null and name = ${q(catalog)}) from recipes r where r.title = ${q(r.title)} and not exists (select 1 from recipe_ingredients x where x.recipe_id = r.id and x.raw = ${q(line)});`,
    );
  }
}
sql.push("update recipes set dish_type = 'pâtes' where title = 'Sundried Tomato Pesto';");
// Official pages found online for screenshot/pasted recipes.
{
  const starter = JSON.parse(readFileSync(join(ROOT, "public", "starter", "recipes.json"), "utf8")) as { title: string; source_url: string | null }[];
  const results = JSON.parse(readFileSync(join(ROOT, "data", "image-search-results.json"), "utf8")) as { title: string; status: string; pageUrl: string | null }[];
  for (const x of results.filter((x) => x.status === "found" && x.pageUrl)) {
    const s = starter.find((r) => r.title === x.title);
    if (s?.source_url) sql.push(`update recipes set source_url = ${q(s.source_url)} where title = ${q(s.title)} and source_url is null;`);
  }
}
for (const title of ["Nouilles udon au tofu croustillant", "Salade Thaï", "Feta au four à l'indienne"]) {
  const r = find(title);
  sql.push(`update recipes set instructions = ${q(JSON.stringify(r.instructions))}::jsonb where title = ${q(r.title)};`);
}

// Moussaka (added 2026-09-29) for households that already imported the starter set.
{
  const m = find("Vegetarian Moussaka");
  const starter = JSON.parse(readFileSync(join(ROOT, "public", "starter", "recipes.json"), "utf8")) as {
    title: string;
    image_url: string | null;
    dish_type: string;
    protein: string;
    seasons: string[];
    ingredients: { catalog: string | null }[];
  }[];
  const s = starter.find((x) => x.title === m.title)!;
  const values = m.ingredients
    .map(
      (i, n) =>
        `(${n}, ${q(i.section)}, ${q(i.raw)}, ${q(i.quantity)}, ${q(i.quantityMax)}, ${q(i.unit)}, ${q(i.name)}, ${q(i.note)}, ${i.optional}, ${q(s.ingredients[n].catalog)})`,
    )
    .join(",\n  ");
  sql.push(
    "",
    "-- Vegetarian Moussaka for households that already have the starter recipes.",
    `with h as (select distinct household_id from recipes where title = 'My Lasagne' and household_id not in (select household_id from recipes where title = ${q(m.title)})),`,
    `r as (insert into recipes (household_id, title, source_type, source_url, image_url, servings, total_minutes, instructions, dish_type, protein, seasons) select household_id, ${q(m.title)}, 'url', ${q(m.sourceUrl)}, ${q(s.image_url)}, ${m.servings}, ${q(m.totalMinutes)}, ${q(JSON.stringify(m.instructions))}::jsonb, ${q(s.dish_type)}, ${q(s.protein)}, array[${s.seasons.map(q).join(", ")}]::text[] from h returning id)`,
    "insert into recipe_ingredients (recipe_id, position, section, raw, quantity, quantity_max, unit, name, note, optional, ingredient_id)",
    "select r.id, v.position, v.section, v.raw, v.quantity::numeric, v.quantity_max::numeric, v.unit, v.name, v.note, v.optional, i.id",
    `from r cross join (values\n  ${values}\n) v(position, section, raw, quantity, quantity_max, unit, name, note, optional, catalog)`,
    "left join ingredients i on i.household_id is null and i.name = v.catalog;",
  );
}

// Grocery list in French: rename catalogue items in place first (so the seed below does not duplicate them).
const renames = JSON.parse(readFileSync(join(ROOT, "data", "catalog-renames.json"), "utf8")) as Record<string, string>;
const renameSql = Object.entries(renames).map(
  ([from, to]) => `update ingredients set name = ${q(to)} where household_id is null and name = ${q(from)};`,
);

// The catalogue seed is idempotent (on conflict do nothing): run it first so new items and aliases exist.
const catalog = readFileSync(join(ROOT, "supabase", "seed", "01_catalog.sql"), "utf8");
writeFileSync(
  join(ROOT, "supabase", "migrations", "0003_portions_filters.sql"),
  `-- Default unit for bare numbers ("2 ail" = 2 gousses), used by the catalogue seed below.\nalter table ingredients add column if not exists count_unit text;\n\n-- Catalogue names in French.\n${renameSql.join("\n")}\n\n${catalog}\n${sql.join("\n")}\n`,
);
console.log(`${sql.length} lignes -> supabase/migrations/0003_portions_filters.sql`);
