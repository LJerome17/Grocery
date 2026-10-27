// Audit of the grocery list (2026-10-27, re-run after commit 15e6a65): an expected list computed here, independently
// of src/lib/shopping.ts, is compared with the list the app writes, after a first generation and after regenerations
// that follow edits (recipes removed / added, multiplier changed, portions changed, recipes postponed with or without
// their ingredients already bought). The app is driven through its real functions (saveWeek / saveWeeks,
// postponeRecipe, loadWeek, generateList, listStatus) over an in-memory Supabase that also runs the two functions of
// migration 0015 (save_weeks, replace_list), re-written here from the SQL. Each simulated week uses the rpc path, the
// PGRST202 fallback (migration not applied) or a mix of both. Read-only on the app and on the live database.
//
// Run: npx vitest run src/validation/audit/list-oracle.test.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------- in-memory Supabase

type Row = Record<string, unknown>;
const mem = vi.hoisted(() => ({
  tables: new Map<string, Record<string, unknown>[]>(),
  seq: 0,
  /** "rpc": migration 0015 applied; "fallback": PostgREST answers PGRST202; "mixed": each call one or the other. */
  mode: "rpc" as "rpc" | "fallback" | "mixed",
  coin: (): number => 0.5,
  calls: new Map<string, number>(),
  /** Error injection: given "table:op" or "rpc:name", an error to return instead of running the request. */
  fail: null as null | ((what: string) => { code: string; message: string } | null),
}));

vi.mock("../../lib/supabase", () => {
  const DEFAULTS: Record<string, Record<string, unknown>> = {
    // Column defaults (0001, 0003, 0014): both paths leave these to the database.
    week_plans: { suppers: 5, people: 2, lunches: 2, store: "maxi", portions: 20, seasons: null, exclude_dish_types: [] },
    week_plan_recipes: { position: 0, multiplier: 1, postponed: false, already_bought: false, cooked: false },
    shopping_items: { ingredient_id: null, quantity_text: null, pantry: false, manual: false, checked: false, aisle: "autre", position: 0 },
  };
  const table = (t: string) => {
    if (!mem.tables.has(t)) mem.tables.set(t, []);
    return mem.tables.get(t)!;
  };
  const count = (k: string) => mem.calls.set(k, (mem.calls.get(k) ?? 0) + 1);
  class Q {
    op: "select" | "insert" | "upsert" | "delete" | "update" | null = null;
    payload: Record<string, unknown>[] = [];
    conflict: string[] = [];
    filters: ((r: Record<string, unknown>) => boolean)[] = [];
    cols: string | null = null;
    returning = false;
    mode: "many" | "single" | "maybe" = "many";
    orderBy: string | null = null;
    constructor(public t: string) {}
    select(cols = "*") {
      if (this.op) this.returning = true;
      else this.op = "select";
      this.cols = cols;
      return this;
    }
    insert(rows: Record<string, unknown> | Record<string, unknown>[]) {
      this.op = "insert";
      this.payload = Array.isArray(rows) ? rows : [rows];
      return this;
    }
    upsert(row: Record<string, unknown>, opts?: { onConflict?: string }) {
      this.op = "upsert";
      this.payload = [row];
      this.conflict = (opts?.onConflict ?? "id").split(",").map((s) => s.trim());
      return this;
    }
    delete() {
      this.op = "delete";
      return this;
    }
    update(v: Record<string, unknown>) {
      this.op = "update";
      this.payload = [v];
      return this;
    }
    eq(c: string, v: unknown) {
      this.filters.push((r) => r[c] === v);
      return this;
    }
    in(c: string, vs: unknown[]) {
      this.filters.push((r) => vs.includes(r[c]));
      return this;
    }
    order(c: string) {
      this.orderBy = c;
      return this;
    }
    single() {
      this.mode = "single";
      return this;
    }
    maybeSingle() {
      this.mode = "maybe";
      return this;
    }
    project(r: Record<string, unknown>) {
      if (!this.cols || this.cols === "*") return { ...r };
      return Object.fromEntries(this.cols.split(",").map((c) => [c.trim(), r[c.trim()]]));
    }
    run(): { data: unknown; error: unknown } {
      const injected = mem.fail?.(`${this.t}:${this.op}`);
      if (injected) return { data: null, error: injected };
      const rows = table(this.t);
      const match = (r: Record<string, unknown>) => this.filters.every((f) => f(r));
      let out: Record<string, unknown>[] = [];
      if (this.op === "select") out = rows.filter(match);
      else if (this.op === "insert") {
        for (const p of this.payload) {
          const r = { ...DEFAULTS[this.t], ...p, id: p.id ?? `${this.t}-${++mem.seq}` };
          rows.push(r);
          out.push(r);
        }
      } else if (this.op === "upsert") {
        const p = this.payload[0];
        const ex = rows.find((r) => this.conflict.every((c) => r[c] === p[c]));
        if (ex) {
          Object.assign(ex, p);
          out.push(ex);
        } else {
          const r = { ...DEFAULTS[this.t], ...p, id: p.id ?? `${this.t}-${++mem.seq}` };
          rows.push(r);
          out.push(r);
        }
      } else if (this.op === "delete") {
        const keep = rows.filter((r) => !match(r));
        rows.length = 0;
        rows.push(...keep);
        return { data: null, error: null };
      } else if (this.op === "update") {
        for (const r of rows.filter(match)) Object.assign(r, this.payload[0]);
        return { data: null, error: null };
      }
      if (this.op !== "select" && !this.returning) return { data: null, error: null };
      if (this.orderBy) out = [...out].sort((a, b) => Number(a[this.orderBy!]) - Number(b[this.orderBy!]));
      const data = out.map((r) => this.project(r));
      if (this.mode === "single") return data.length === 1 ? { data: data[0], error: null } : { data: null, error: new Error(`single: ${data.length} rows`) };
      if (this.mode === "maybe") return data.length > 1 ? { data: null, error: new Error("maybeSingle: several rows") } : { data: data[0] ?? null, error: null };
      return { data, error: null };
    }
    then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) {
      return Promise.resolve().then(() => this.run()).then(res, rej);
    }
  }

  // ---- Migration 0015, re-written from the SQL: jsonb ->> text, casts, coalesce, NOT NULL columns, one transaction.
  type J = Record<string, unknown>;
  const pgErr = (code: string, message: string) => Object.assign(new Error(message), { code });
  /** jsonb ->> : SQL NULL for a missing key or a JSON null, else the text of the value. */
  const txt = (o: J, k: string): string | null => {
    const v = o[k];
    if (v === undefined || v === null) return null;
    return typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  };
  const int = (v: string | null) => {
    if (v === null) return null;
    if (!/^\s*[+-]?\d+\s*$/.test(v)) throw pgErr("22P02", `invalid input syntax for type integer: "${v}"`);
    return Number(v);
  };
  const num = (v: string | null) => {
    if (v === null) return null;
    if (!/^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(v)) throw pgErr("22P02", `invalid input syntax for type numeric: "${v}"`);
    return Number(v);
  };
  const bool = (v: string | null) => {
    if (v === null) return null;
    if (v === "true") return true;
    if (v === "false") return false;
    throw pgErr("22P02", `invalid input syntax for type boolean: "${v}"`);
  };
  /** jsonb_array_elements(coalesce(o->k, '[]')): a missing key is an empty array; a JSON null or scalar fails. */
  const elements = (o: J, k: string): unknown[] => {
    if (!(k in o)) return [];
    const v = o[k];
    if (!Array.isArray(v)) throw pgErr("22023", "cannot extract elements from a scalar");
    return v;
  };
  const asText = (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x)); // jsonb_array_elements_text
  const notNull = <T,>(v: T | null, col: string): T => {
    if (v === null) throw pgErr("23502", `null value in column "${col}" violates not-null constraint`);
    return v;
  };
  const SQL: Record<string, (a: J) => unknown> = {
    save_weeks(a) {
      const household = notNull(txt(a, "p_household"), "household_id");
      const result: J[] = [];
      for (const w of elements(a, "p_weeks") as J[]) {
        const vals = {
          week_start: notNull(txt(w, "week_start"), "week_start"),
          suppers: notNull(int(txt(w, "suppers")), "suppers"),
          portions: notNull(int(txt(w, "portions")), "portions"),
          seasons: elements(w, "seasons").map(asText),
          exclude_dish_types: elements(w, "exclude_dish_types").map(asText),
        };
        // insert ... on conflict (household_id, week_start) do update set suppers, portions, seasons, exclude_dish_types
        const plans = table("week_plans");
        let plan = plans.find((p) => p.household_id === household && p.week_start === vals.week_start);
        if (plan) Object.assign(plan, { suppers: vals.suppers, portions: vals.portions, seasons: vals.seasons, exclude_dish_types: vals.exclude_dish_types });
        else {
          plan = { ...DEFAULTS.week_plans, household_id: household, ...vals, id: `week_plans-${++mem.seq}` };
          plans.push(plan);
        }
        const pid = plan.id;
        const wpr = table("week_plan_recipes");
        const keep = wpr.filter((x) => x.plan_id !== pid);
        wpr.length = 0;
        wpr.push(...keep);
        for (const r of elements(w, "recipes") as J[]) {
          wpr.push({
            ...DEFAULTS.week_plan_recipes,
            id: `week_plan_recipes-${++mem.seq}`,
            plan_id: pid,
            recipe_id: notNull(txt(r, "recipe_id"), "recipe_id"),
            position: notNull(int(txt(r, "position")), "position"),
            multiplier: notNull(int(txt(r, "multiplier")), "multiplier"),
            portions: notNull(num(txt(r, "portions")), "portions"),
            postponed: bool(txt(r, "postponed")) ?? false,
            already_bought: bool(txt(r, "already_bought")) ?? false,
          });
        }
        const items = wpr.filter((x) => x.plan_id === pid).sort((x, y) => Number(x.position) - Number(y.position));
        result.push({ plan: { ...plan }, items: items.map((x) => ({ ...x })) });
      }
      return result;
    },
    replace_list(a) {
      const plan = txt(a, "p_plan");
      const t = table("shopping_items");
      // coalesce(array_agg(coalesce(ingredient_id::text, 'label:' || label)), '{}') ... where plan_id = p_plan and checked and not manual
      const ticked = t
        .filter((r) => r.plan_id === plan && r.checked === true && r.manual === false)
        .map((r) => (r.ingredient_id != null ? String(r.ingredient_id) : r.label == null ? null : `label:${r.label}`));
      const keep = t.filter((r) => !(r.plan_id === plan && r.manual === false));
      t.length = 0;
      t.push(...keep);
      let n = 0;
      for (const r of elements(a, "p_rows") as J[]) {
        const iid = txt(r, "ingredient_id") === "" ? null : txt(r, "ingredient_id"); // nullif(r->>'ingredient_id', '')
        const label = txt(r, "label");
        const key = iid ?? (label === null ? null : `label:${label}`);
        // key = any(ticked), three-valued: NULL when the key is NULL, or when no element matches and one is NULL.
        const checked = key === null ? null : ticked.includes(key) ? true : ticked.includes(null) ? null : false;
        t.push({
          id: `shopping_items-${++mem.seq}`,
          plan_id: notNull(plan, "plan_id"),
          ingredient_id: iid,
          label: notNull(label, "label"),
          quantity_text: txt(r, "quantity_text"),
          aisle: notNull(txt(r, "aisle"), "aisle"),
          pantry: bool(txt(r, "pantry")) ?? false,
          manual: false,
          checked: notNull(checked, "checked"),
          position: notNull(int(txt(r, "position")), "position"),
        });
        n++;
      }
      return n; // get diagnostics n = row_count
    },
  };
  const rpc = (name: string, args: Record<string, unknown>) => ({
    then(res: (v: unknown) => unknown, rej: (e: unknown) => unknown) {
      return Promise.resolve()
        .then(() => {
          const useRpc = mem.mode === "rpc" || (mem.mode === "mixed" && mem.coin() < 0.5);
          if (!useRpc || !SQL[name]) {
            count(`${name} : repli (PGRST202)`);
            return { data: null, error: { code: "PGRST202", message: `Could not find the function public.${name} in the schema cache`, details: null, hint: null } };
          }
          const injected = mem.fail?.(`rpc:${name}`);
          if (injected) return { data: null, error: injected };
          // One transaction: on error every table is put back as it was.
          const saved = new Map([...mem.tables].map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
          try {
            const data = SQL[name](JSON.parse(JSON.stringify(args)));
            count(`${name} : rpc`);
            return { data: JSON.parse(JSON.stringify(data)), error: null };
          } catch (e) {
            mem.tables = saved;
            count(`${name} : rpc en erreur`);
            return { data: null, error: { code: (e as { code?: string }).code ?? "P0001", message: (e as Error).message, details: null, hint: null } };
          }
        })
        .then(res, rej);
    },
  });
  return { supabase: () => ({ from: (t: string) => new Q(t), rpc }), SUPABASE_URL: "http://test", SUPABASE_KEY: "test" };
});

import { buildShoppingList, type CatalogItem, type ListIngredient } from "../../lib/shopping";
import { setLang } from "../../lib/i18n";
import { UNIT_BY_KEY } from "../../lib/units";
import { AISLES } from "../../lib/aisles";
import { assignMultipliers, seasonOf } from "../../lib/planner";
import { flagsOf, generateList, listStatus, loadWeek, nextWeekOf, postponeRecipe, saveWeek, saveWeeks, type PostponeFlags, type WeekSettings } from "../../lib/weekPlan";
import type { Ingredient, Recipe, RecipeIngredient, WeekPlan, WeekPlanRecipe } from "../../lib/db";

// ---------------------------------------------------------------- data

const ROOT = join(__dirname, "..", "..", "..");
type Equiv = { unit: string; [k: string]: number | string | undefined };
type CatEntry = { name: string; name_en?: string; aisle: string; pantry?: boolean; count_unit?: string; equiv?: Equiv; ml_per_can?: number; cooked_ratio?: number };
type SIng = { raw: string; quantity: number | null; quantity_max: number | null; unit: string | null; name: string; note?: string | null; optional: boolean; catalog: string | null };
type SRecipe = { title: string; servings?: number | null; ingredients: SIng[] };

const CAT: CatEntry[] = JSON.parse(readFileSync(join(ROOT, "data", "catalog.json"), "utf8")).ingredients;
const STARTER: SRecipe[] = JSON.parse(readFileSync(join(ROOT, "public", "starter", "recipes.json"), "utf8"));
const CATN = new Map(CAT.map((c) => [c.name, c]));

const ing = (i: Partial<SIng>): SIng => ({ raw: i.raw ?? i.name ?? "", quantity: null, quantity_max: null, unit: null, name: "", note: null, optional: false, catalog: null, ...i });
// Synthetic recipes: lines a household could type that the starter book does not have (unmatched names, juice cases).
const SYNTH: SRecipe[] = [
  {
    title: "Synthé : lignes non reconnues",
    servings: 4,
    ingredients: [
      ing({ name: "Sauce secrète de grand-mère", quantity: 2, unit: "tbsp" }),
      ing({ name: "sauce secrete de grand mere", quantity: 1, unit: "tsp" }),
      ing({ name: "Épice mystère", optional: true }),
      ing({ name: "Eau", quantity: 2, unit: "cup", catalog: "Eau" }),
    ],
  },
  {
    title: "Synthé : jus de 1 à 2 citrons",
    servings: 2,
    ingredients: [ing({ raw: "Jus de 1 à 2 citrons", name: "citrons", note: "jus", quantity: 1, quantity_max: 2, catalog: "Citron" }), ing({ raw: "1 c. à soupe de jus de citron", name: "jus de citron", quantity: 1, unit: "tbsp", catalog: "Citron" })],
  },
  {
    title: "Synthé : jus de lime et quartiers facultatifs",
    servings: 4,
    ingredients: [ing({ raw: "Jus de 1 lime", name: "lime", note: "jus", quantity: 1, catalog: "Lime" }), ing({ raw: "Quartiers de lime pour servir (facultatif)", name: "Quartiers de lime", optional: true, catalog: "Lime" })],
  },
  {
    title: "Synthé : jus de citron au goût, facultatif",
    servings: 4,
    ingredients: [ing({ raw: "Jus de citron, au goût (facultatif)", name: "jus de citron", note: "au goût", optional: true, catalog: "Citron" }), ing({ name: "Sauce secrète de grand-mère", quantity: 1, unit: "cup" })],
  },
];
const POOL: SRecipe[] = [...STARTER, ...SYNTH];

// App-side rows (ids are opaque, like the database's uuids).
const CAT_ID = new Map(CAT.map((c, k) => [c.name, `ing-${k}`]));
const CAT_BY_ID = new Map(CAT.map((c, k) => [`ing-${k}`, c]));
const CAT_ROWS = CAT.map((c) => ({ id: CAT_ID.get(c.name)!, household_id: null, name: c.name, name_en: c.name_en ?? null, aisle: c.aisle, pantry: !!c.pantry, count_unit: c.count_unit ?? null, equiv: c.equiv ?? null, ml_per_can: c.ml_per_can ?? null, cooked_ratio: c.cooked_ratio ?? null }) as unknown as Ingredient);
const RECIPE_ROWS = POOL.map((r, k) => ({ id: `rec-${k}`, household_id: "hh", title: r.title, servings: r.servings ?? 4 }) as unknown as Recipe);
const ING_ROWS = POOL.flatMap((r, k) => r.ingredients.map((i, p) => ({ id: `ri-${k}-${p}`, recipe_id: `rec-${k}`, position: p, section: null, raw: i.raw, quantity: i.quantity, quantity_max: i.quantity_max, unit: i.unit, name: i.name, note: i.note ?? null, optional: i.optional, ingredient_id: i.catalog ? CAT_ID.get(i.catalog)! : null }) as RecipeIngredient));
const RECIPE_OF = new Map(POOL.map((r, k) => [`rec-${k}`, r]));
const SERVINGS = (id: string) => RECIPE_OF.get(id)?.servings ?? 4;
const CATALOG_MAP = new Map<string, CatalogItem>(CAT_ROWS.map((c) => [c.id, c as unknown as CatalogItem]));
const appIngredients = (r: SRecipe): ListIngredient[] => r.ingredients.map((i) => ({ quantity: i.quantity, quantity_max: i.quantity_max, unit: i.unit, name: i.name, note: i.note ?? null, raw: i.raw, optional: i.optional, ingredient_id: i.catalog ? CAT_ID.get(i.catalog)! : null }));

// ---------------------------------------------------------------- independent reference

// Unit factors re-derived (Canadian metric kitchen: cup 250 ml, tbsp 15 ml, tsp 5 ml; lb 453.6 g, oz 28.35 g).
// They are cross-checked against units.ts in a separate test, not imported.
const MASS: Record<string, number> = { g: 1, kg: 1000, mg: 0.001, lb: 453.6, oz: 28.35 };
const VOL: Record<string, number> = { ml: 1, cl: 10, l: 1000, tsp: 5, tbsp: 15, cup: 250, floz: 29.57 };
const NEGLIGIBLE = new Set(["pinch", "sprig", "handful", "drizzle"]);
const COUNT_UNITS = ["can", "pack", "carton", "punnet", "portion", "sheet", "ball", "head", "clove", "stalk", "bunch", "slice", "cube", "block", "piece", "inch"];
const WHOLE = new Set(["", ...COUNT_UNITS]); // documented: whole units rounded up (every count unit but the negligible ones)
const LABELS: Record<"fr" | "en", Record<string, [string, string]>> = {
  fr: { can: ["boîte", "boîtes"], pack: ["paquet", "paquets"], carton: ["berlingot", "berlingots"], punnet: ["barquette", "barquettes"], portion: ["portion", "portions"], sheet: ["feuille", "feuilles"], ball: ["boule", "boules"], head: ["tête", "têtes"], clove: ["gousse", "gousses"], stalk: ["branche", "branches"], bunch: ["botte", "bottes"], slice: ["tranche", "tranches"], cube: ["cube", "cubes"], block: ["bloc", "blocs"], piece: ["morceau", "morceaux"], inch: ["pouce", "pouces"] },
  en: { can: ["can", "cans"], pack: ["pack", "packs"], carton: ["carton", "cartons"], punnet: ["container", "containers"], portion: ["serving", "servings"], sheet: ["sheet", "sheets"], ball: ["ball", "balls"], head: ["head", "heads"], clove: ["clove", "cloves"], stalk: ["stalk", "stalks"], bunch: ["bunch", "bunches"], slice: ["slice", "slices"], cube: ["cube", "cubes"], block: ["block", "blocks"], piece: ["piece", "pieces"], inch: ["inch", "inches"] },
};
const FRUIT: Record<string, { juice: string; ml: number }> = { Citron: { juice: "Jus de citron", ml: 45 }, Lime: { juice: "Jus de lime", ml: 30 } };

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const nameKeyOf = (s: string) => fold(s).replace(/[^a-z0-9]+/g, " ").trim();
const asksJuiceOnly = (i: SIng) => {
  const t = fold(`${i.name} ${i.note ?? ""} ${i.raw ?? ""}`);
  return /\b(jus|juice|juiced)\b/.test(t) && !/zest/.test(t);
};

/** Per recipe and fruit: "juice" when every line of that fruit only wants its juice, "fruit" otherwise. */
function citrusClass(r: SRecipe): Map<string, "juice" | "fruit"> {
  const out = new Map<string, "juice" | "fruit">();
  for (const f of Object.keys(FRUIT)) {
    const lines = r.ingredients.filter((i) => i.catalog === f);
    if (!lines.length) continue;
    out.set(f, lines.every(asksJuiceOnly) && CATN.has(FRUIT[f].juice) ? "juice" : "fruit");
  }
  return out;
}
function withJuice(r: SRecipe): SIng[] {
  const cls = citrusClass(r);
  return r.ingredients.map((i) => {
    if (!i.catalog || cls.get(i.catalog) !== "juice") return i;
    const { juice, ml } = FRUIT[i.catalog];
    if (i.quantity !== null && (i.unit === null || i.unit === "" || i.unit === "piece"))
      return { ...i, catalog: juice, unit: "ml", quantity: i.quantity * ml, quantity_max: i.quantity_max === null ? null : i.quantity_max * ml };
    return { ...i, catalog: juice };
  });
}

type Exp = { key: string; cat: CatEntry | null; label: string; aisle: string; pantry: boolean; optional: boolean; unquantified: boolean; buying: Map<string, [number, number]>; recipes: string[] };
type WeekItem = { recipe: SRecipe; factor: number };

function expected(items: WeekItem[], lang: "fr" | "en"): Map<string, Exp> {
  const out = new Map<string, Exp>();
  const base = new Map<string, Map<string, [number, number]>>();
  for (const { recipe, factor } of items) {
    for (const i of withJuice(recipe)) {
      const c = i.catalog ? CATN.get(i.catalog) ?? null : null;
      if (c?.aisle === "aucun") continue; // water
      const key = c ? `cat:${c.name}` : `nom:${nameKeyOf(i.name)}`;
      let e = out.get(key);
      if (!e) {
        e = { key, cat: c, label: c ? (lang === "en" && c.name_en) || c.name : i.name, aisle: c?.aisle ?? "autre", pantry: !!c?.pantry, optional: true, unquantified: false, buying: new Map(), recipes: [] };
        out.set(key, e);
        base.set(key, new Map());
      }
      if (!e.recipes.includes(recipe.title)) e.recipes.push(recipe.title);
      if (!i.optional) e.optional = false;
      if (i.quantity === null || i.quantity === 0 || (i.unit !== null && NEGLIGIBLE.has(i.unit))) {
        e.unquantified = true;
        continue;
      }
      let unit = i.unit ?? "";
      if ((unit === "" || unit === "piece") && c?.count_unit) unit = c.count_unit;
      let b = unit, k = 1;
      if (unit in MASS) [b, k] = ["g", MASS[unit]];
      else if (unit in VOL) [b, k] = ["ml", VOL[unit]];
      if (c?.cooked_ratio && /\b(cuit|cuits|cuite|cuites|cooked)\b/.test(fold(i.name))) k /= c.cooked_ratio;
      const m = base.get(key)!;
      const p = m.get(b) ?? [0, 0];
      m.set(b, [p[0] + i.quantity * factor * k, p[1] + Math.max(i.quantity, i.quantity_max ?? i.quantity) * factor * k]);
    }
  }
  for (const e of out.values()) {
    const eq = e.cat?.equiv;
    for (const [u, [lo, hi]] of base.get(e.key)!) {
      let t = u, k = 1;
      if (eq && u !== eq.unit) {
        if (u === "ml" && typeof eq.ml === "number") [t, k] = [eq.unit, 1 / eq.ml];
        else if (u === "g" && typeof eq.g === "number") [t, k] = [eq.unit, 1 / eq.g];
        else if (typeof eq[u] === "number") [t, k] = [eq.unit, eq[u] as number];
      }
      const p = e.buying.get(t) ?? [0, 0];
      e.buying.set(t, [p[0] + lo * k, p[1] + hi * k]);
    }
  }
  return out;
}

// Expected text, written independently of units.ts.
const roundUp = (v: number) => Math.max(1, Math.ceil(v - 0.1));
function side(v: number, u: string, lang: "fr" | "en"): { num: string; unit: string } {
  const dec = (n: number) => { const s = String(Math.round(n * 10) / 10); return lang === "fr" ? s.replace(".", ",") : s; };
  if (u === "g" || u === "ml") {
    const r = Math.max(v > 0 ? 1 : 0, Math.round(v));
    return r >= 1000 ? { num: dec(v / 1000), unit: u === "g" ? "kg" : "L" } : { num: String(r), unit: u };
  }
  const n = roundUp(v);
  const lab = LABELS[lang][u];
  return { num: String(n), unit: lab ? lab[n >= 2 ? 1 : 0] : "" };
}
function partTexts(u: string, lo: number, hi: number, lang: "fr" | "en", canMl: number | undefined): Set<string> {
  const out = new Set<string>();
  const to = lang === "fr" ? "à" : "to";
  const eps = [0, 1e-7, -1e-7];
  for (const a of eps) for (const b of eps) {
    const l = side(lo + a, u, lang), h = side(hi + b, u, lang);
    const join = (s: { num: string; unit: string }) => (s.unit ? `${s.num} ${s.unit}` : s.num);
    // Rule (commit 15e6a65): a count unit is written once, in the form of the high end ("1 à 2 gousses",
    // "1 to 2 cans"); grams / millilitres once when both ends show the same unit ("250 à 375 ml"), else at both ends
    // ("800 g à 1,2 kg"); a bare number has no unit ("4 à 8").
    let t: string;
    if (join(l) === join(h)) t = join(h);
    else if ((u !== "g" && u !== "ml") || l.unit === h.unit) t = `${l.num} ${to} ${join(h)}`;
    else t = `${join(l)} ${to} ${join(h)}`;
    out.add(u === "can" && canMl ? `${t} (${canMl} ml)` : t);
  }
  return out;
}

// Reading the app's text back (own parser).
function readLabels(lang: "fr" | "en"): Map<string, [string, number]> {
  const m = new Map<string, [string, number]>([["g", ["g", 1]], ["kg", ["g", 1000]], ["ml", ["ml", 1]], ["L", ["ml", 1000]]]);
  for (const [u, [s, p]] of Object.entries(LABELS[lang])) {
    m.set(s, [u, 1]);
    m.set(p, [u, 1]);
  }
  return m;
}
const READ = { fr: readLabels("fr"), en: readLabels("en") };
const FR_FRAC: Record<string, number> = { "¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3 };
function readSide(s: string, lang: "fr" | "en"): { v: number; unit: string | null; mult: number } {
  const m = s.trim().match(/^(\d+(?:[.,]\d+)?)?\s?([¼½¾⅓⅔])?(?:\s(.+))?$/);
  if (!m || (!m[1] && !m[2])) throw new Error(`illisible « ${s} »`);
  const v = (m[1] ? Number(m[1].replace(",", ".")) : 0) + (m[2] ? FR_FRAC[m[2]] : 0);
  if (!m[3]) return { v, unit: null, mult: 1 };
  const u = READ[lang].get(m[3]);
  if (!u) throw new Error(`unité inconnue « ${m[3]} »`);
  return { v, unit: u[0], mult: u[1] };
}
function readText(text: string, lang: "fr" | "en"): Map<string, { lo: number; hi: number; raw: string; canMl?: number }> {
  const out = new Map<string, { lo: number; hi: number; raw: string; canMl?: number }>();
  for (const raw of text.split(" + ")) {
    let part = raw;
    const size = part.match(/ \((\d+) ml\)$/);
    if (size) part = part.slice(0, -size[0].length);
    const sides = part.split(lang === "fr" ? " à " : " to ");
    if (sides.length > 2) throw new Error(`plage illisible « ${raw} »`);
    const h = readSide(sides[sides.length - 1], lang);
    const l = sides.length === 2 ? readSide(sides[0], lang) : h;
    const unit = h.unit ?? "";
    if ((l.unit ?? unit) !== unit) throw new Error(`deux unités « ${raw} »`);
    if (out.has(unit)) throw new Error(`unité répétée « ${text} »`);
    out.set(unit, { lo: l.v * (l.unit ? l.mult : h.mult), hi: h.v * h.mult, raw, ...(size ? { canMl: Number(size[1]) } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------- mismatch log

type Mismatch = { type: string; article: string; detail: string; repro: string };
const LOG = new Map<string, { n: number; ex: Mismatch }>();
const stats = {
  weeks: 0,
  modes: new Map<string, number>(),
  regenerations: 0,
  directLists: 0,
  rangeLists: 0,
  linesChecked: 0,
  ops: new Map<string, number>(),
  juicePairs: 0,
  juiceSingles: 0,
  ticksCarried: 0,
  ticksLostKeyGone: 0,
  ticksLostFruitToJuice: 0,
  ticksLostOptionalFlip: 0,
  manualTickedSameKey: 0,
  status: new Map<string, number>(),
  postponesChecked: 0,
  differential: 0,
};
const bumpIn = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
/** Observations that are not mismatches of the list itself (counted and reported, not failed). */
const NOTES = new Map<string, { n: number; ex: string }>();
const note = (k: string, ex: string) => {
  const e = NOTES.get(k);
  if (e) e.n++;
  else NOTES.set(k, { n: 1, ex });
};
const bump = (op: string) => stats.ops.set(op, (stats.ops.get(op) ?? 0) + 1);
function record(m: Mismatch) {
  const k = `${m.type} | ${m.article}`;
  const e = LOG.get(k);
  if (e) e.n++;
  else LOG.set(k, { n: 1, ex: m });
}
const describeWeek = (items: WeekItem[], lang: string) => `${items.map((x) => `« ${x.recipe.title} » ×${x.factor}`).join(" + ") || "(aucune recette)"} [${lang}]`;

type GotLine = { key: string; label: string; quantityText: string; aisle: string; pantry: boolean; optional: boolean };

/** Compare the app's lines (label without the "(facultatif)" suffix) with the expected ones. Returns mismatches. */
function compare(got: GotLine[], exp: Map<string, Exp>, lang: "fr" | "en", repro: string): Mismatch[] {
  const mm: Mismatch[] = [];
  const add = (type: string, article: string, detail: string) => mm.push({ type, article, detail, repro });
  const seen = new Set<string>();
  for (const g of got) {
    if (seen.has(g.key)) add("doublon", g.label, `deux lignes pour ${g.key}`);
    seen.add(g.key);
    const e = exp.get(g.key);
    if (!e) {
      add("article en trop", g.label, `« ${g.label} : ${g.quantityText} » absent de la référence`);
      continue;
    }
    stats.linesChecked++;
    if (g.label !== e.label) add("libellé", e.label, `« ${g.label} » au lieu de « ${e.label} »`);
    if (g.aisle !== e.aisle) add("rayon", e.label, `${g.aisle} au lieu de ${e.aisle}`);
    if (g.pantry !== e.pantry) add("garde-manger", e.label, `${g.pantry} au lieu de ${e.pantry}`);
    if (g.optional !== e.optional) add("facultatif", e.label, `${g.optional} au lieu de ${e.optional}`);
    const besoin = lang === "fr" ? "au besoin" : "as needed";
    if (e.buying.size === 0) {
      if (g.quantityText !== besoin) add("quantité", e.label, `« ${g.quantityText} » au lieu de « ${besoin} »`);
      continue;
    }
    let read: ReturnType<typeof readText>;
    try {
      read = readText(g.quantityText, lang);
    } catch (err) {
      add("texte illisible", e.label, `« ${g.quantityText} » : ${(err as Error).message}`);
      continue;
    }
    const want = [...e.buying.keys()].sort(), have = [...read.keys()].sort();
    if (want.join("|") !== have.join("|")) {
      add("unités", e.label, `« ${g.quantityText} » : unités ${have.join(",")} au lieu de ${want.join(",")} (attendu ${[...e.buying].map(([u, [a, b]]) => `${a.toFixed(2)}-${b.toFixed(2)} ${u || "unités"}`).join(" + ")})`);
      continue;
    }
    for (const [u, [lo, hi]] of e.buying) {
      const r = read.get(u)!;
      const okNum = (want: number, got: number) => {
        if (u === "g" || u === "ml") return Math.abs(got - want) <= (Math.round(want) >= 1000 ? 50 : 0.5) + 1e-6 || (want > 0 && want < 0.5 && got === 1);
        if (WHOLE.has(u)) return [roundUp(want + 1e-7), roundUp(want - 1e-7)].includes(got);
        return Math.abs(got - want) <= 0.05 * Math.max(1, want);
      };
      if (!okNum(lo, r.lo) || !okNum(hi, r.hi)) {
        add("quantité", e.label, `« ${g.quantityText} » ; attendu ${lo.toFixed(3)} à ${hi.toFixed(3)} ${u || "unités"}`);
        continue;
      }
      const canMl = e.cat?.ml_per_can;
      if ((u === "can" && canMl ? canMl : undefined) !== r.canMl) add("format de boîte", e.label, `« ${g.quantityText} » ; format attendu ${canMl}`);
      const texts = partTexts(u, lo, hi, lang, canMl);
      if (!texts.has(r.raw)) add("texte", e.label, `« ${r.raw} » au lieu de « ${[...texts][0]} »`);
    }
  }
  for (const e of exp.values()) if (!seen.has(e.key)) add("article manquant", e.label, `absent de la liste (recettes : ${e.recipes.join(", ")})`);
  return mm;
}

const keyOfApp = (ingredientId: string | null, label: string) => (ingredientId ? `cat:${CAT_BY_ID.get(ingredientId)?.name ?? ingredientId}` : `nom:${nameKeyOf(label)}`);

function checkDirect(items: WeekItem[], lang: "fr" | "en"): Mismatch[] {
  setLang(lang);
  let lines;
  try {
    lines = buildShoppingList(items.map(({ recipe, factor }) => ({ title: recipe.title, factor, ingredients: appIngredients(recipe) })), CATALOG_MAP);
  } finally {
    setLang("fr");
  }
  stats.directLists++;
  const got = lines.map((l) => ({ key: keyOfApp(l.ingredientId, l.label), label: l.label, quantityText: l.quantityText, aisle: l.aisle, pantry: l.pantry, optional: l.optional }));
  const mm = compare(got, expected(items, lang), lang, describeWeek(items, lang));
  mm.forEach(record);
  return mm;
}

// ---------------------------------------------------------------- random

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- simulation of the app

const HH = "hh";
const W0 = "2026-10-26";
const W1 = nextWeekOf(W0);
const SUFFIX = { fr: " (facultatif)", en: " (optional)" };
const MANUAL_LABELS = ["Papier essuie-tout", "Café", "Citron", "Lait d'avoine", "Sauce secrète de grand-mère", "Épice mystère (facultatif)", "Bananes"];

const rowsOf = (planId: string) => (mem.tables.get("shopping_items") ?? []).filter((r) => r.plan_id === planId);
const snap = (rows: Row[]) => JSON.stringify(rows.map((r) => ({ ...r })).sort((a, b) => String(a.id).localeCompare(String(b.id))));
const tableSnap = (...ts: string[]) => ts.map((t) => snap(mem.tables.get(t) ?? [])).join("\n");
const cloneTables = () => new Map([...mem.tables].map(([k, v]) => [k, v.map((r) => ({ ...r }))]));
/** JSON with sorted keys: the rpc path returns rows built by to_jsonb, the fallback the rows PostgREST sends. */
const canon = (v: unknown): string =>
  Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon((v as Row)[k])}`).join(",")}}` : JSON.stringify(v ?? null);

async function withLang<T>(lang: "fr" | "en", fn: () => Promise<T>): Promise<T> {
  setLang(lang);
  try {
    return await fn();
  } finally {
    setLang("fr");
  }
}

const sortItems = (items: WeekPlanRecipe[]) => [...items].sort((a, b) => a.position - b.position);
const activeOf = (items: WeekPlanRecipe[]) => sortItems(items).filter((it) => !it.already_bought).map((it) => ({ recipe: RECIPE_OF.get(it.recipe_id)!, factor: it.multiplier || 1 }));
function reproOf(items: WeekPlanRecipe[], lang: "fr" | "en") {
  const boughtOnly = items.filter((it) => it.already_bought).map((it) => RECIPE_OF.get(it.recipe_id)!.title);
  return `${describeWeek(activeOf(items), lang)}${boughtOnly.length ? ` ; déjà achetées : ${boughtOnly.map((t) => `« ${t} »`).join(", ")}` : ""}`;
}

// ---- listStatus: what it must answer, from the rows the app actually writes when the list is made again.
const genRows = (rows: Row[]) => rows.filter((r) => !r.manual);
const textSig = (rows: Row[]) => genRows(rows).map((r) => `${r.label}|${r.quantity_text ?? ""}`).sort().join("\n");
const fullSig = (rows: Row[]) => genRows(rows).map((r) => JSON.stringify([r.ingredient_id ?? null, r.label, r.quantity_text ?? null, r.aisle, !!r.pantry, r.position])).sort().join("\n");
/** The recipes the list is made from (already-bought ones aside) and the language. */
const weekSig = (items: WeekPlanRecipe[], lang: string) => `${lang}:${items.filter((i) => !i.already_bought).map((i) => `${i.recipe_id}x${i.multiplier || 1}`).sort().join(",")}`;
const lastGen = new Map<string, string>();
/** Lists whose ticked items were removed at the store since they were last made. */
const cleared = new Set<string>();

function checkStatus(where: string, got: string, stored: Row[], fresh: Row[], repro: string) {
  const want = !genRows(stored).length ? "none" : textSig(stored) === textSig(fresh) ? "current" : "stale";
  bumpIn(stats.status, `${where} : ${got}`);
  if (got !== want) record({ type: "listStatus", article: where, detail: `« ${got} » au lieu de « ${want} »`, repro });
  else if (got === "current" && fullSig(stored) !== fullSig(fresh)) record({ type: "listStatus « current » mais lignes différentes", article: where, detail: "même libellé et quantité, autre ingredient_id / rayon / garde-manger / position", repro });
}

async function regenerate(s: Sim, week: string) {
  const lang = s.lang;
  const { plan, items } = await loadWeek(HH, week);
  if (!plan) return;
  const before = rowsOf(plan.id).map((r) => ({ ...r }));
  const others = snap((mem.tables.get("shopping_items") ?? []).filter((r) => r.plan_id !== plan.id));
  const repro = reproOf(items, lang);
  const status0 = await withLang(lang, () => listStatus(plan.id, items, RECIPE_ROWS, ING_ROWS, CAT_ROWS));
  // Sometimes the page is opened in the other language: the list made in that language, then put back.
  if (s.rand() < 0.15) {
    const other = lang === "fr" ? "en" : "fr";
    const st = await withLang(other, () => listStatus(plan.id, items, RECIPE_ROWS, ING_ROWS, CAT_ROWS));
    const saved = cloneTables();
    await withLang(other, () => generateList(plan.id, items, RECIPE_ROWS, ING_ROWS, CAT_ROWS));
    const fresh = rowsOf(plan.id).map((r) => ({ ...r }));
    mem.tables = saved;
    checkStatus(`autre langue (${other})`, st, before, fresh, repro);
  }
  await withLang(lang, () => generateList(plan.id, items, RECIPE_ROWS, ING_ROWS, CAT_ROWS));
  stats.regenerations++;
  const after = rowsOf(plan.id).map((r) => ({ ...r }));
  checkStatus("avant « Faire la liste »", status0, before, after, repro);
  if (status0 !== "current" && genRows(after).length && lastGen.get(plan.id) === weekSig(items, lang)) {
    // Same recipes, same multipliers, same language as when the list was made.
    if (!cleared.has(plan.id)) record({ type: "listStatus", article: "recettes inchangées", detail: `« ${status0} » sans changement de recettes ni article retiré`, repro });
    else if (status0 === "stale") note("listStatus « stale » (bandeau « les recettes ont changé ») sans changement de recettes : articles cochés retirés sur la page Liste", repro);
    else note("listStatus « none » alors que la liste avait été faite : toutes les lignes générées retirées sur la page Liste", repro);
  }
  const status1 = await withLang(lang, () => listStatus(plan.id, items, RECIPE_ROWS, ING_ROWS, CAT_ROWS));
  checkStatus("juste après « Faire la liste »", status1, after, after, repro);
  if (!genRows(after).length) note(`liste faite mais vide : listStatus « none » (${items.length ? "toutes les recettes déjà achetées" : "aucune recette"})`, repro);
  lastGen.set(plan.id, weekSig(items, lang));
  cleared.delete(plan.id);
  verifyRegen(plan.id, items, before, others, lang);
}

function verifyRegen(planId: string, items: WeekPlanRecipe[], before: Row[], others: string, lang: "fr" | "en") {
  const active = activeOf(items);
  const boughtOnly = items.filter((it) => it.already_bought).map((it) => RECIPE_OF.get(it.recipe_id)!.title);
  const repro = reproOf(items, lang);
  const add = (type: string, article: string, detail: string) => record({ type, article, detail, repro });
  const after = rowsOf(planId);
  if (snap((mem.tables.get("shopping_items") ?? []).filter((r) => r.plan_id !== planId)) !== others) add("autre liste modifiée", "-", "la liste d'une autre semaine a changé");
  // Manual items: kept exactly.
  const manualBefore = before.filter((r) => r.manual), manualAfter = after.filter((r) => r.manual);
  if (snap(manualBefore) !== snap(manualAfter)) add("article manuel", "-", `${manualBefore.length} avant, ${manualAfter.length} après`);
  const gen = after.filter((r) => !r.manual).sort((a, b) => Number(a.position) - Number(b.position));
  // Positions 0..n-1.
  gen.forEach((r, k) => r.position !== k && add("positions", String(r.label), `position ${r.position} au rang ${k}`));
  // Lines.
  const exp = expected(active, lang);
  const sfx = SUFFIX[lang];
  const got: GotLine[] = gen.map((r) => {
    const label = String(r.label);
    const optional = label.endsWith(sfx);
    const base = optional ? label.slice(0, -sfx.length) : label;
    return { key: keyOfApp(r.ingredient_id as string | null, base), label: base, quantityText: String(r.quantity_text), aisle: String(r.aisle), pantry: !!r.pantry, optional };
  });
  compare(got, exp, lang, repro).forEach(record);
  // A line only an already-bought recipe needs must not be there.
  for (const g of got) {
    const e = exp.get(g.key);
    if (!e && boughtOnly.length) add("ligne d'une recette déjà achetée", g.label, `« ${g.label} : ${g.quantityText} »`);
  }
  // Order: garde-manger last, then aisle, then name.
  const order = new Map(AISLES.map(([k], i) => [k, i]));
  for (let k = 1; k < got.length; k++) {
    const a = got[k - 1], b = got[k];
    const c = Number(a.pantry) - Number(b.pantry) || (order.get(a.aisle) ?? 99) - (order.get(b.aisle) ?? 99) || a.label.localeCompare(b.label, "fr");
    if (c > 0) add("ordre", b.label, `« ${a.label} » avant « ${b.label} »`);
  }
  // Ticks: a generated line is ticked exactly when a ticked generated line of the previous list had the same key
  // (ingredient_id, or label for an unmatched line). A ticked manual item never ticks a generated line.
  const tkey = (r: Row) => (r.ingredient_id ? `id:${r.ingredient_id}` : `label:${r.label}`);
  const tickedGen = new Set(before.filter((r) => !r.manual && r.checked).map(tkey));
  const tickedManual = new Set(before.filter((r) => r.manual && r.checked).map(tkey));
  const newKeys = new Set(gen.map(tkey));
  for (const r of before.filter((x) => !x.manual && x.checked)) {
    if (newKeys.has(tkey(r))) stats.ticksCarried++;
    else {
      stats.ticksLostKeyGone++;
      const name = r.ingredient_id ? CAT_BY_ID.get(String(r.ingredient_id))?.name : null;
      const juice = name && FRUIT[name] ? CAT_ID.get(FRUIT[name].juice) : null;
      const fruit = name ? Object.entries(FRUIT).find(([, f]) => f.juice === name)?.[0] : null;
      if ((juice && newKeys.has(`id:${juice}`)) || (fruit && newKeys.has(`id:${CAT_ID.get(fruit)}`))) stats.ticksLostFruitToJuice++;
      const lab = String(r.label);
      if (!r.ingredient_id && (newKeys.has(`label:${lab}${sfx}`) || (lab.endsWith(sfx) && newKeys.has(`label:${lab.slice(0, -sfx.length)}`)))) stats.ticksLostOptionalFlip++;
    }
  }
  for (const r of gen) {
    const want = tickedGen.has(tkey(r));
    if (tickedManual.has(tkey(r)) && !want) stats.manualTickedSameKey++;
    if (!!r.checked !== want) {
      if (r.checked && tickedManual.has(tkey(r))) add("coche reprise d'un article manuel", String(r.label), `ligne générée « ${r.label} » cochée parce que l'article manuel du même nom l'était`);
      else add("coche", String(r.label), `${r.checked ? "cochée" : "décochée"} ; attendu ${want ? "cochée" : "décochée"}`);
    }
  }
}

type Sim = { lang: "fr" | "en"; settings: Record<string, WeekSettings>; rand: () => number };

async function current(week: string) {
  const { items } = await loadWeek(HH, week);
  return sortItems(items);
}
const plannedOf = (items: WeekPlanRecipe[]) => items.map((i) => ({ id: i.recipe_id, multiplier: i.multiplier || 1 }));
const refit = (ids: string[], portions: number) => {
  const m = assignMultipliers(ids.map(SERVINGS), portions);
  return ids.map((id, i) => ({ id, multiplier: m[i] }));
};
const proj = (i: WeekPlanRecipe) => ({ recipe_id: i.recipe_id, position: i.position, multiplier: i.multiplier, portions: Number(i.portions), postponed: !!i.postponed, already_bought: !!i.already_bought });
const planProj = (p: WeekPlan) => ({ suppers: p.suppers, portions: p.portions, seasons: p.seasons, exclude_dish_types: p.exclude_dish_types });
const settingsProj = (st: WeekSettings) => ({ suppers: st.recipes, portions: st.portions, seasons: st.seasons, exclude_dish_types: st.excludeDishTypes });

/** What a save must leave in the database, and the save's answer must be what is stored. */
async function checkSaved(week: string, st: WeekSettings, planned: { id: string; multiplier: number }[], flags: Map<string, PostponeFlags>, answer: { plan: WeekPlan; items: WeekPlanRecipe[] }, repro: string) {
  const add = (detail: string) => record({ type: "enregistrement", article: week, detail, repro: `${repro} [${mem.mode}]` });
  const stored = await loadWeek(HH, week);
  if (!stored.plan) return add("semaine absente après l'enregistrement");
  const want = planned.map((p, position) => ({ recipe_id: p.id, position, multiplier: p.multiplier, portions: p.multiplier * SERVINGS(p.id), postponed: !!flags.get(p.id)?.postponed, already_bought: !!flags.get(p.id)?.already_bought }));
  if (canon(sortItems(stored.items).map(proj)) !== canon(want)) add(`recettes enregistrées ${canon(sortItems(stored.items).map(proj))} au lieu de ${canon(want)}`);
  if (canon(planProj(stored.plan)) !== canon(settingsProj(st))) add(`réglages ${canon(planProj(stored.plan))} au lieu de ${canon(settingsProj(st))}`);
  if (canon(answer) !== canon({ plan: stored.plan, items: sortItems(stored.items) })) add("la réponse de l'enregistrement diffère de ce qui est stocké");
}

async function persist(s: Sim, week: string, planned: { id: string; multiplier: number }[], flags?: Map<string, PostponeFlags>) {
  const items = await current(week);
  const st = s.settings[week];
  st.recipes = Math.max(st.recipes, planned.length);
  const f = flags ?? flagsOf(items);
  const answer = await saveWeek(HH, week, st, planned, SERVINGS, f);
  await checkSaved(week, st, planned, f, answer, `enregistrement de ${week}`);
}

/** Postpone as the Semaine page does it, and check both weeks afterwards. */
async function checkedPostpone(s: Sim, recipeId: string, bought: boolean): Promise<"already" | "moved"> {
  const b0 = await loadWeek(HH, W0), b1 = await loadWeek(HH, W1);
  const i0 = sortItems(b0.items), i1 = sortItems(b1.items);
  const dbBefore = tableSnap("week_plans", "week_plan_recipes");
  const title = RECIPE_OF.get(recipeId)!.title;
  const repro = `reporter « ${title} » (${bought ? "déjà achetée" : "pas achetée"}) de ${reproOf(i0, s.lang)} vers ${b1.plan ? reproOf(i1, s.lang) : "(semaine suivante pas encore prévue)"} [${mem.mode}]`;
  const add = (detail: string) => record({ type: "reporter", article: title, detail, repro });
  const res = await postponeRecipe(HH, { week: W0, settings: s.settings[W0], planned: plannedOf(i0), flags: flagsOf(i0) }, recipeId, bought, s.settings[W0], SERVINGS);
  stats.postponesChecked++;
  const a0 = await loadWeek(HH, W0), a1 = await loadWeek(HH, W1);
  if (i1.some((i) => i.recipe_id === recipeId)) {
    if (res !== "already") add("la recette est déjà prévue la semaine suivante, réponse autre que « already »");
    if (tableSnap("week_plans", "week_plan_recipes") !== dbBefore) add("semaines modifiées malgré « already »");
    return "already";
  }
  if (res === "already") {
    add("« already » alors que la recette n'est pas prévue la semaine suivante");
    return "already";
  }
  const moved = i0.find((i) => i.recipe_id === recipeId)!;
  const want0 = i0.filter((i) => i.recipe_id !== recipeId).map((i, position) => ({ ...proj(i), position }));
  const want1 = [...i1.map(proj), { recipe_id: recipeId, position: i1.length, multiplier: moved.multiplier, portions: moved.multiplier * SERVINGS(recipeId), postponed: true, already_bought: bought }];
  if (canon(sortItems(a0.items).map(proj)) !== canon(want0)) add(`semaine de départ ${canon(sortItems(a0.items).map(proj))} au lieu de ${canon(want0)}`);
  if (canon(sortItems(a1.items).map(proj)) !== canon(want1)) add(`semaine suivante ${canon(sortItems(a1.items).map(proj))} au lieu de ${canon(want1)}`);
  if (a0.plan?.id !== b0.plan?.id) add("la semaine de départ a changé d'id (sa liste ne la suit plus)");
  if (b1.plan && a1.plan?.id !== b1.plan.id) add("la semaine suivante a changé d'id (sa liste ne la suit plus)");
  if (a0.plan && canon(planProj(a0.plan)) !== canon(settingsProj(s.settings[W0]))) add(`réglages de départ ${canon(planProj(a0.plan))}`);
  const season = seasonOf(new Date(`${W1}T12:00:00`));
  const f = s.settings[W0];
  const want1Plan = b1.plan
    ? { suppers: Math.max(b1.plan.suppers, want1.length), portions: b1.plan.portions ?? 20, seasons: b1.plan.seasons ?? [season], exclude_dish_types: b1.plan.exclude_dish_types ?? [] }
    : { suppers: Math.max(f.recipes, want1.length), portions: f.portions, seasons: [season], exclude_dish_types: f.excludeDishTypes };
  if (!a1.plan || canon(planProj(a1.plan)) !== canon(want1Plan)) add(`réglages de la semaine suivante ${a1.plan ? canon(planProj(a1.plan)) : "absents"} au lieu de ${canon(want1Plan)}`);
  if (canon(res.from) !== canon({ plan: a0.plan, items: sortItems(a0.items) })) add("réponse « from » différente de ce qui est stocké");
  if (canon(res.next) !== canon({ plan: a1.plan, items: sortItems(a1.items) })) add("réponse « next » différente de ce qui est stocké");
  if (a1.plan) s.settings[W1] = { portions: a1.plan.portions, recipes: a1.plan.suppers, seasons: a1.plan.seasons ?? [season], excludeDishTypes: a1.plan.exclude_dish_types };
  return "moved";
}

/** One edit, as the Semaine page does it. Returns the weeks whose list should be regenerated. */
async function edit(s: Sim): Promise<string[]> {
  const lists = tableSnap("shopping_items");
  const weeks = await editWeek(s);
  if (tableSnap("shopping_items") !== lists) record({ type: "liste modifiée par un enregistrement", article: "-", detail: "shopping_items a changé sans « Faire la liste »", repro: `[${mem.mode}]` });
  return weeks;
}

async function editWeek(s: Sim): Promise<string[]> {
  const r = s.rand;
  const week = r() < 0.7 ? W0 : W1;
  const items = await current(week);
  const ids = items.map((i) => i.recipe_id);
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const ops: string[] = [];
  if (ids.length > 1) ops.push("retirer");
  if (ids.length < 8) ops.push("ajouter");
  if (ids.length) ops.push("multiplicateur", "portions -", "portions +");
  if (week === W0 && ids.length) ops.push("reporter (déjà acheté)", "reporter (pas acheté)", "reporter (déjà acheté)", "reporter (pas acheté)");
  if (items.some((i) => i.postponed)) ops.push("basculer déjà acheté", "basculer déjà acheté");
  const op = pick(ops);
  bump(op);
  const st = s.settings[week];
  switch (op) {
    case "retirer": {
      const gone = pick(ids);
      await persist(s, week, refit(ids.filter((x) => x !== gone), st.portions));
      return [week];
    }
    case "ajouter": {
      const free = RECIPE_ROWS.map((x) => x.id).filter((x) => !ids.includes(x));
      await persist(s, week, refit([...ids, pick(free)], st.portions));
      return [week];
    }
    case "multiplicateur": {
      const id = pick(ids);
      const m = 1 + Math.floor(r() * 4);
      await persist(s, week, plannedOf(items).map((p) => (p.id === id ? { ...p, multiplier: Math.max(1, m) } : p)));
      return [week];
    }
    case "portions -":
    case "portions +": {
      const d = 1 + Math.floor(r() * 10);
      st.portions = Math.min(80, Math.max(1, st.portions + (op === "portions +" ? d : -d)));
      // Same recipes refitted to the new portions (the page's fallback; planWeek may also add or drop recipes).
      await persist(s, week, refit(ids, st.portions));
      return [week];
    }
    case "reporter (déjà acheté)":
    case "reporter (pas acheté)": {
      const moved = pick(plannedOf(items));
      const res = await checkedPostpone(s, moved.id, op === "reporter (déjà acheté)");
      if (res === "already") {
        bump(`${op} : déjà prévue la semaine suivante`);
        return [W1];
      }
      return [W0, W1];
    }
    case "basculer déjà acheté": {
      const it = pick(items.filter((i) => i.postponed));
      const flags = flagsOf(items);
      flags.set(it.recipe_id, { ...flags.get(it.recipe_id)!, already_bought: !it.already_bought });
      await persist(s, week, plannedOf(items), flags);
      return [week];
    }
  }
  return [];
}

/** At the store: tick / untick items, add a manual item, remove ticked items. */
async function shop(s: Sim, week: string) {
  const r = s.rand;
  const { plan } = await loadWeek(HH, week);
  if (!plan) return;
  const rows = rowsOf(plan.id);
  for (const row of rows) if (r() < 0.25) {
    row.checked = !row.checked;
    bump("cocher / décocher");
  }
  if (r() < 0.4) {
    const label = MANUAL_LABELS[Math.floor(r() * MANUAL_LABELS.length)];
    (mem.tables.get("shopping_items") ?? mem.tables.set("shopping_items", []).get("shopping_items")!).push({ id: `manual-${++mem.seq}`, plan_id: plan.id, ingredient_id: null, label, quantity_text: null, aisle: "autre", pantry: false, manual: true, checked: r() < 0.5, position: 9999 });
    bump("article manuel ajouté");
  }
  if (r() < 0.08) {
    const t = mem.tables.get("shopping_items")!;
    const keep = t.filter((x) => !(x.plan_id === plan.id && x.checked));
    t.length = 0;
    t.push(...keep);
    bump("retirer les cochés");
    cleared.add(plan.id);
  }
}

type Mode = "rpc" | "fallback" | "mixed";

async function simulateWeek(seed: number, forced?: Mode) {
  const rand = rng(seed);
  const pathRand = rng(seed ^ 0x5bd1e995); // separate stream: the path does not change the rest of the week
  mem.tables.clear();
  mem.seq = 0;
  lastGen.clear();
  cleared.clear();
  const m = pathRand();
  mem.mode = forced ?? (m < 0.45 ? "rpc" : m < 0.9 ? "fallback" : "mixed");
  mem.coin = pathRand;
  bumpIn(stats.modes, mem.mode);
  const lang: "fr" | "en" = rand() < 0.25 ? "en" : "fr";
  const s: Sim = { lang, settings: {}, rand };
  const chooseRecipes = (n: number, avoid: string[] = []) => {
    const ids = new Set<string>();
    while (ids.size < n) {
      const id = RECIPE_ROWS[Math.floor(rand() * RECIPE_ROWS.length)].id;
      if (!avoid.includes(id)) ids.add(id);
    }
    return [...ids].map((id) => ({ id, multiplier: 1 + Math.floor(rand() * 4) }));
  };
  // This week: 1-8 recipes; some came from the previous week (postponed, maybe already bought).
  const p0 = chooseRecipes(1 + Math.floor(rand() * 8));
  const f0 = new Map<string, PostponeFlags>();
  for (const p of p0) if (rand() < 0.15) f0.set(p.id, { postponed: true, already_bought: rand() < 0.5 });
  s.settings[W0] = { portions: p0.reduce((t, p) => t + p.multiplier * SERVINGS(p.id), 0), recipes: p0.length, seasons: ["automne"], excludeDishTypes: [] };
  // Next week: sometimes planned already, sometimes saved together with this week (saveWeeks).
  if (rand() < 0.5) {
    const p1 = chooseRecipes(Math.floor(rand() * 5), p0.map((p) => p.id));
    const f1 = new Map<string, PostponeFlags>();
    for (const p of p1) if (rand() < 0.3) f1.set(p.id, { postponed: true, already_bought: rand() < 0.5 });
    s.settings[W1] = { portions: Math.max(1, p1.reduce((t, p) => t + p.multiplier * SERVINGS(p.id), 0)), recipes: Math.max(1, p1.length), seasons: ["automne"], excludeDishTypes: [] };
    if (rand() < 0.5) {
      const [a0, a1] = await saveWeeks(HH, [{ week: W0, settings: s.settings[W0], planned: p0, flags: f0 }, { week: W1, settings: s.settings[W1], planned: p1, flags: f1 }], SERVINGS);
      bump("saveWeeks (deux semaines)");
      await checkSaved(W0, s.settings[W0], p0, f0, a0, "saveWeeks, semaine 1");
      await checkSaved(W1, s.settings[W1], p1, f1, a1, "saveWeeks, semaine 2");
    } else {
      await checkSaved(W0, s.settings[W0], p0, f0, await saveWeek(HH, W0, s.settings[W0], p0, SERVINGS, f0), "premier enregistrement");
      await checkSaved(W1, s.settings[W1], p1, f1, await saveWeek(HH, W1, s.settings[W1], p1, SERVINGS, f1), "premier enregistrement");
    }
  } else await checkSaved(W0, s.settings[W0], p0, f0, await saveWeek(HH, W0, s.settings[W0], p0, SERVINGS, f0), "premier enregistrement");
  if (!s.settings[W1]) s.settings[W1] = { ...s.settings[W0] }; // used if a recipe is added there
  stats.weeks++;
  await regenerate(s, W0);
  if (rand() < 0.5) await regenerate(s, W1);
  const steps = 3 + Math.floor(rand() * 6);
  for (let k = 0; k < steps; k++) {
    await shop(s, W0);
    await shop(s, W1);
    const touched = await edit(s);
    for (const w of touched) await regenerate(s, w);
    if (rand() < 0.15) await regenerate(s, touched.includes(W0) ? W1 : W0); // the other list, unchanged recipes
  }
}

// ---------------------------------------------------------------- tests

const NWEEKS = 3000;
const NDIFF = 300;

afterAll(() => {
  const lines: string[] = [];
  lines.push(`\n================ AUDIT LISTE D'ÉPICERIE ================`);
  lines.push(`semaines simulées : ${stats.weeks} (${[...stats.modes].map(([k, n]) => `${k} ${n}`).join(", ")}) ; dont ${stats.differential} en double (rpc puis repli) ; régénérations (generateList) : ${stats.regenerations}`);
  lines.push(`listes directes (buildShoppingList) : ${stats.directLists} (dont ${stats.rangeLists} de plages au hasard) ; lignes comparées : ${stats.linesChecked} ; audit jus : ${stats.juiceSingles} recettes seules, ${stats.juicePairs} paires`);
  lines.push(`reports vérifiés (postponeRecipe) : ${stats.postponesChecked}`);
  lines.push(`coches : ${stats.ticksCarried} reprises ; ${stats.ticksLostKeyGone} perdues car la ligne a disparu (dont ${stats.ticksLostFruitToJuice} : la ligne Citron ou Lime a disparu, ou sa ligne Jus, alors que l autre reste ; ${stats.ticksLostOptionalFlip} : ligne non reconnue passée de facultative à obligatoire ou l'inverse) ; ${stats.manualTickedSameKey} lignes générées restées décochées malgré un article manuel coché du même nom`);
  lines.push(`chemins (appels) :`);
  for (const [k, n] of [...mem.calls].filter(([k]) => !k.startsWith("requête")).sort()) lines.push(`  ${k.padEnd(48)} ${n}`);
  lines.push(`listStatus :`);
  for (const [k, n] of [...stats.status].sort()) lines.push(`  ${k.padEnd(48)} ${n}`);
  lines.push(`opérations :`);
  for (const [op, n] of [...stats.ops].sort((a, b) => b[1] - a[1])) lines.push(`  ${op.padEnd(48)} ${n}`);
  const total = [...LOG.values()].reduce((t, e) => t + e.n, 0);
  lines.push(`écarts : ${total} (${LOG.size} groupes type | article)`);
  for (const [k, { n, ex }] of [...LOG].sort((a, b) => b[1].n - a[1].n)) lines.push(`  [${n}] ${k}\n      ${ex.detail}\n      ex. : ${ex.repro}`);
  lines.push(`observations (hors écarts) : ${NOTES.size}`);
  for (const [k, { n, ex }] of [...NOTES].sort((a, b) => b[1].n - a[1].n)) lines.push(`  [${n}] ${k}\n      ex. : ${ex}`);
  console.log(lines.join("\n"));
});


describe("tables d'unités (référence re-dérivée vs units.ts)", () => {
  it("mêmes facteurs", () => {
    for (const [u, f] of Object.entries({ ...MASS, ...VOL })) expect(UNIT_BY_KEY[u]?.factor, u).toBe(f);
    for (const u of [...COUNT_UNITS, ...NEGLIGIBLE]) expect(UNIT_BY_KEY[u]?.dim, u).toBe("count");
  });
});

describe("1. semaines au hasard, liste directe (FR et EN)", () => {
  it("3000 semaines de 1 à 8 recettes, ×1 à ×4", () => {
    const rand = rng(271828);
    let bad = 0;
    for (let w = 0; w < 3000; w++) {
      const n = 1 + Math.floor(rand() * 8);
      const picked = new Set<number>();
      while (picked.size < n) picked.add(Math.floor(rand() * POOL.length));
      const items = [...picked].map((k) => ({ recipe: POOL[k], factor: 1 + Math.floor(rand() * 4) }));
      bad += checkDirect(items, rand() < 0.3 ? "en" : "fr").length;
    }
    expect(bad, "écarts (voir le résumé)").toBe(0);
  });
});

describe("1b. plages au hasard (unités comptées, g, ml, nombres seuls), liste directe", () => {
  it("3000 recettes de 1 à 3 lignes en plage, ×1 à ×3, FR et EN", () => {
    const rand = rng(161803);
    const units: (string | null)[] = [null, null, "piece", ...COUNT_UNITS, "g", "kg", "ml", "l", "cup", "tbsp", "tsp", "lb", "oz"];
    const cats = CAT.filter((c) => c.aisle !== "aucun" && !FRUIT[c.name] && !/^Jus de/.test(c.name));
    const qs = [0.25, 0.5, 1, 1, 1, 1.5, 2, 3, 4, 250, 400, 800];
    let bad = 0;
    for (let t = 0; t < 3000; t++) {
      const ings = Array.from({ length: 1 + Math.floor(rand() * 3) }, (_, k) => {
        const c = cats[Math.floor(rand() * cats.length)];
        const q = qs[Math.floor(rand() * qs.length)];
        const qm = rand() < 0.85 ? q + [0.5, 1, 1, 2, 3, 400][Math.floor(rand() * 6)] : null;
        return ing({ raw: `ligne ${k}`, name: `article ${k}`, quantity: q, quantity_max: qm, unit: units[Math.floor(rand() * units.length)], catalog: c.name });
      });
      stats.rangeLists++;
      bad += checkDirect([{ recipe: { title: `Plage ${t}`, servings: 4, ingredients: ings }, factor: 1 + Math.floor(rand() * 3) }], rand() < 0.4 ? "en" : "fr").length;
    }
    expect(bad, "écarts (voir le résumé)").toBe(0);
  });
});

describe("2. semaines simulées : génération puis régénérations après modifications (rpc, repli PGRST202, mélange)", () => {
  it(`${NWEEKS} semaines`, async () => {
    const count = () => [...LOG.values()].reduce((t, e) => t + e.n, 0);
    const before = count();
    for (let w = 0; w < NWEEKS; w++) await simulateWeek(1000 + w);
    const after = count();
    for (const op of ["retirer", "ajouter", "multiplicateur", "portions -", "portions +", "reporter (déjà acheté)", "reporter (pas acheté)", "basculer déjà acheté", "saveWeeks (deux semaines)"]) expect(stats.ops.get(op) ?? 0, op).toBeGreaterThanOrEqual(200);
    for (const k of ["save_weeks : rpc", "save_weeks : repli (PGRST202)", "replace_list : rpc", "replace_list : repli (PGRST202)"]) expect(mem.calls.get(k) ?? 0, k).toBeGreaterThanOrEqual(1000);
    for (const k of ["avant « Faire la liste » : none", "avant « Faire la liste » : current", "avant « Faire la liste » : stale", "juste après « Faire la liste » : current"]) expect(stats.status.get(k) ?? 0, k).toBeGreaterThanOrEqual(200);
    expect(after - before, "écarts (voir le résumé)").toBe(0);
  }, 900_000);
});

describe("2b. mêmes semaines par le rpc puis par le repli : même état final", () => {
  it(`${NDIFF} semaines en double`, async () => {
    let diff = 0, first = "";
    for (let w = 0; w < NDIFF; w++) {
      const states: string[] = [];
      for (const mode of ["rpc", "fallback"] as const) {
        await simulateWeek(50_000 + w, mode);
        states.push(["week_plans", "week_plan_recipes", "shopping_items"].map((t) => canon(mem.tables.get(t) ?? [])).join("\n"));
      }
      stats.differential++;
      if (states[0] !== states[1]) {
        diff++;
        first ||= `graine ${50_000 + w}`;
      }
    }
    expect(diff, `états différents (première : ${first})`).toBe(0);
  }, 300_000);
});

describe("3. audit jus de citron / lime", () => {
  const citrus = POOL.filter((r) => citrusClass(r).size > 0);
  const line = (items: WeekItem[], label: string) => {
    const lines = buildShoppingList(items.map(({ recipe, factor }) => ({ title: recipe.title, factor, ingredients: appIngredients(recipe) })), CATALOG_MAP);
    return lines.find((l) => l.label === label)?.quantityText;
  };
  const presence = (items: WeekItem[]) => {
    const lines = buildShoppingList(items.map(({ recipe, factor }) => ({ title: recipe.title, factor, ingredients: appIngredients(recipe) })), CATALOG_MAP);
    const errs: string[] = [];
    for (const [fruit, { juice }] of Object.entries(FRUIT)) {
      const cls = items.map((x) => citrusClass(x.recipe).get(fruit));
      const wantFruit = cls.includes("fruit"), wantJuice = cls.includes("juice");
      const hasFruit = lines.some((l) => l.label === fruit), hasJuice = lines.some((l) => l.label === juice);
      if (wantFruit !== hasFruit) errs.push(`${fruit} ${hasFruit ? "présent" : "absent"}`);
      if (wantJuice !== hasJuice) errs.push(`${juice} ${hasJuice ? "présent" : "absent"}`);
    }
    if (errs.length) record({ type: "règle du jus (présence)", article: errs.join(", "), detail: errs.join(", "), repro: describeWeek(items, "fr") });
    return errs;
  };
  it(`chaque recette avec citron / lime (${citrus.length}) seule, ×1 à ×3, FR et EN`, () => {
    let bad = 0;
    for (const r of citrus) for (const f of [1, 2, 3]) for (const lang of ["fr", "en"] as const) {
      stats.juiceSingles++;
      bad += checkDirect([{ recipe: r, factor: f }], lang).length + presence([{ recipe: r, factor: f }]).length;
    }
    expect(bad).toBe(0);
  });
  it("chaque paire de recettes avec citron / lime, ×1 à ×3 chacune", () => {
    let bad = 0;
    for (let a = 0; a < citrus.length; a++) for (let b = a + 1; b < citrus.length; b++) for (const fa of [1, 2, 3]) for (const fb of [1, 2, 3]) {
      const items = [{ recipe: citrus[a], factor: fa }, { recipe: citrus[b], factor: fb }];
      stats.juicePairs++;
      bad += checkDirect(items, "fr").length + presence(items).length;
    }
    expect(bad).toBe(0);
  });
  it("cas calculés à la main", () => {
    const R = (t: string) => POOL.find((r) => r.title === t)!;
    // ¼ lime (fruit) + jus de ½ lime (jus seul) : 1 lime + 15 ml de jus de lime.
    const w1 = [{ recipe: R("Bol quinoa, tofu et arachides"), factor: 1 }, { recipe: R("Salade Thaï"), factor: 1 }];
    expect([line(w1, "Lime"), line(w1, "Jus de lime")]).toEqual(["1", "15 ml"]);
    // ½ lemon + jus de ½ citron : 1 citron + 22,5 -> 23 ml.
    const w2 = [{ recipe: R("Warm Pearl Couscous Salad"), factor: 1 }, { recipe: R("Tofu grillé aux olives et à l'aneth"), factor: 1 }];
    expect([line(w2, "Citron"), line(w2, "Jus de citron")]).toEqual(["1", "23 ml"]);
    // Zeste + jus de ½ + jus de 2 : tout sur le fruit, 3,5 -> 4 limes.
    const w3 = [{ recipe: R("Tofu BBQ, salade de tomates et maïs"), factor: 1 }];
    expect([line(w3, "Lime"), line(w3, "Jus de lime")]).toEqual(["4", undefined]);
    // Zeste de 1 lime + 45 + 30 ml de jus, ×2 : (1 + 2,5) × 2 = 7 limes.
    expect(line([{ recipe: R("Patates douces farcies à la mexicaine"), factor: 2 }], "Lime")).toBe("7");
    // 1 + ½ c. à soupe de jus de citron, ×3 = 67,5 -> 68 ml, pas de citron.
    const w5 = [{ recipe: R("Salade de quinoa et halloumi sur crème d'avocat"), factor: 3 }];
    expect([line(w5, "Citron"), line(w5, "Jus de citron")]).toEqual([undefined, "68 ml"]);
    // Tranche de lime : le fruit.
    const w6 = [{ recipe: R("Mushroom & Lentil Tacos with Garlic Avocado Cream"), factor: 1 }];
    expect([line(w6, "Lime"), line(w6, "Jus de lime")]).toEqual(["1", undefined]);
    // Lime zestée (fruit) et ½ c. à soupe de jus de citron (jus) dans la même recette.
    const w7 = [{ recipe: R("Vegan Burrito Bowl (Better than Chipotle!)"), factor: 1 }];
    expect([line(w7, "Lime"), line(w7, "Jus de citron"), line(w7, "Citron")]).toEqual(["1", "8 ml", undefined]);
    // Citron demandé (jus et zeste) + jus seul ailleurs : les deux articles.
    const w8 = [{ recipe: R("Lasagne au pesto, petits pois et courgette"), factor: 1 }, { recipe: R("Tofu Magique Bang Bang"), factor: 1 }];
    expect([line(w8, "Citron"), line(w8, "Jus de citron")]).toEqual(["1", "15 ml"]);
    expect(line([{ recipe: R("Vegan Jamaican Lentil Curry"), factor: 1 }], "Jus de lime")).toBe("au besoin");
    expect(line([{ recipe: R("Synthé : jus de 1 à 2 citrons"), factor: 2 }], "Jus de citron")).toBe("120 à 210 ml");
  });
});

describe("4. cas limites et pouvoir de détection de la référence", () => {
  const R = (title: string, ings: Partial<SIng>[]): SRecipe => ({ title, servings: 4, ingredients: ings.map(ing) });
  it("plages en unités comptées, g / kg, jus en c. à thé, zeste seul, quartiers + jus, riz cuit", () => {
    const cases: WeekItem[][] = [
      [{ recipe: R("Plage g kg", [{ raw: "800 g à 1,2 kg de farine", name: "farine", quantity: 800, quantity_max: 1200, unit: "g", catalog: "Farine tout usage" }]), factor: 1 }],
      [{ recipe: R("Jus c. à thé", [{ raw: "1 c. à thé de jus de lime", name: "jus de lime", quantity: 1, unit: "tsp", catalog: "Lime" }]), factor: 3 }],
      [{ recipe: R("Zeste seul", [{ raw: "Zeste de citron", name: "citron", note: "zeste", catalog: "Citron" }]), factor: 1 }],
      [{ recipe: R("Quartiers + jus", [{ raw: "Citron, en quartiers", name: "citron", note: "en quartiers", catalog: "Citron" }, { raw: "Jus de 1 citron", name: "citron", note: "jus", quantity: 1, catalog: "Citron" }]), factor: 2 }],
      [{ recipe: R("Riz cuit", [{ raw: "2 tasses de riz cuit", name: "riz cuit", quantity: 2, unit: "cup", catalog: "Riz blanc" }]), factor: 1 }],
    ];
    const found = cases.map((w) => checkDirect(w, "fr").concat(checkDirect(w, "en")));
    expect(found.flat().map((m) => `${m.type} ${m.article}: ${m.detail}`)).toEqual([]);
  });
  it("la référence voit un multiplicateur faux, une ligne perdue, la règle du jus désactivée", () => {
    const rand = rng(31415);
    let caughtFactor = 0, caughtDrop = 0, caughtJuice = 0, trials = 0;
    const citrus = POOL.filter((r) => [...citrusClass(r).values()].includes("juice"));
    const noJuiceCat = new Map([...CATALOG_MAP].filter(([, c]) => !/^Jus de (citron|lime)$/.test(c.name)));
    const asGot = (lines: ReturnType<typeof buildShoppingList>) => lines.map((l) => ({ key: keyOfApp(l.ingredientId, l.label), label: l.label, quantityText: l.quantityText, aisle: l.aisle, pantry: l.pantry, optional: l.optional }));
    for (let t = 0; t < 300; t++) {
      const items = [0, 1, 2].map(() => ({ recipe: STARTER[Math.floor(rand() * STARTER.length)], factor: 1 + Math.floor(rand() * 3) })).filter((x, i, a) => a.findIndex((y) => y.recipe === x.recipe) === i);
      const app = (its: WeekItem[], cat = CATALOG_MAP) => buildShoppingList(its.map(({ recipe, factor }) => ({ title: recipe.title, factor, ingredients: appIngredients(recipe) })), cat);
      trials++;
      // App fed factor + 1 on the first recipe, compared with the true week.
      const wrong = app(items.map((x, k) => (k === 0 ? { ...x, factor: x.factor + 1 } : x)));
      if (compare(asGot(wrong), expected(items, "fr"), "fr", "").length) caughtFactor++;
      const lines = app(items);
      if (compare(asGot(lines.slice(1)), expected(items, "fr"), "fr", "").length) caughtDrop++;
      const j = [{ recipe: citrus[t % citrus.length], factor: 1 }];
      if (compare(asGot(app(j, noJuiceCat)), expected(j, "fr"), "fr", "").length) caughtJuice++;
    }
    console.log(`détection : multiplicateur faux ${caughtFactor}/${trials}, ligne perdue ${caughtDrop}/${trials}, règle du jus coupée ${caughtJuice}/${trials}`);
    expect(caughtDrop).toBe(trials);
    expect(caughtJuice).toBe(trials);
    expect(caughtFactor).toBeGreaterThan(trials * 0.95);
  });
});

describe("5. constats de l'audit précédent (corrigés par 15e6a65 : tests ordinaires)", () => {
  const R = (title: string, ings: Partial<SIng>[]): SRecipe => ({ title, servings: 4, ingredients: ings.map(ing) });
  const text = (w: WeekItem[]) => buildShoppingList(w.map(({ recipe, factor }) => ({ title: recipe.title, factor, ingredients: appIngredients(recipe) })), CATALOG_MAP)[0].quantityText;
  // Constat B : une plage en unités comptées qui passe le seuil du pluriel répétait l'unité (« 1 gousse à 2 gousses »).
  for (const lang of ["fr", "en"] as const) {
    it(`B. plage « 1 à 2 boîtes » / « 1 à 2 gousses » (${lang})`, () => {
      const cans = (q: number, qm: number, f = 1) => [{ recipe: R("Plage boîtes", [{ raw: `${q} à ${qm} boîtes de pois chiches`, name: "pois chiches", quantity: q, quantity_max: qm, unit: "can", catalog: "Pois chiches (conserve)" }]), factor: f }];
      const cloves = (q: number, qm: number, f = 1) => [{ recipe: R("Plage gousses", [{ raw: `${q} à ${qm} gousses d'ail`, name: "ail", quantity: q, quantity_max: qm, unit: "clove", catalog: "Ail" }]), factor: f }];
      setLang(lang);
      try {
        expect([text(cans(1, 2)), text(cloves(1, 2)), text(cloves(2, 3)), text(cloves(1, 2, 2)), text(cans(0.5, 1))]).toEqual(
          lang === "fr"
            ? ["1 à 2 boîtes (540 ml)", "1 à 2 gousses", "2 à 3 gousses", "2 à 4 gousses", "1 boîte (540 ml)"]
            : ["1 to 2 cans (540 ml)", "1 to 2 cloves", "2 to 3 cloves", "2 to 4 cloves", "1 can (540 ml)"],
        );
        // Grams and millilitres keep both units when they differ.
        const flour = [{ recipe: R("Plage g kg", [{ raw: "800 g à 1,2 kg de farine", name: "farine", quantity: 800, quantity_max: 1200, unit: "g", catalog: "Farine tout usage" }]), factor: 1 }];
        expect(text(flour)).toBe(lang === "fr" ? "800 g à 1,2 kg" : "800 g to 1.2 kg");
      } finally {
        setLang("fr");
      }
      expect(checkDirect(cans(1, 2), lang).concat(checkDirect(cloves(1, 2), lang))).toEqual([]);
    });
  }
  // Constat A : un article manuel coché « Sauce secrète » faisait naître cochée la ligne générée du même nom.
  for (const mode of ["rpc", "fallback"] as const) {
    it(`A. un article manuel coché ne coche pas une ligne générée du même nom (${mode})`, async () => {
      mem.tables.clear();
      mem.mode = mode;
      const id = RECIPE_ROWS[POOL.findIndex((r) => r.title === "Synthé : lignes non reconnues")].id;
      const st: WeekSettings = { portions: 4, recipes: 1, seasons: ["automne"], excludeDishTypes: [] };
      const { plan } = await saveWeek(HH, W0, st, [{ id, multiplier: 1 }], SERVINGS);
      mem.tables.set("shopping_items", [{ id: "m1", plan_id: plan.id, ingredient_id: null, label: "Sauce secrète de grand-mère", quantity_text: null, aisle: "autre", pantry: false, manual: true, checked: true, position: 9999 }]);
      const { items } = await loadWeek(HH, W0);
      await generateList(plan.id, items, RECIPE_ROWS, ING_ROWS, CAT_ROWS);
      const gen = rowsOf(plan.id).find((r) => !r.manual && r.label === "Sauce secrète de grand-mère");
      expect(gen?.checked).toBe(false);
      // A ticked generated line stays ticked after a regeneration, and the manual item is untouched.
      gen!.checked = true;
      await generateList(plan.id, items, RECIPE_ROWS, ING_ROWS, CAT_ROWS);
      expect(rowsOf(plan.id).filter((r) => r.label === "Sauce secrète de grand-mère").map((r) => [r.manual, r.checked])).toEqual([[true, true], [false, true]]);
    });
  }
});

describe("6. listStatus, cas écrits à la main", () => {
  for (const mode of ["rpc", "fallback"] as const) {
    it(`none, current, stale (${mode})`, async () => {
      mem.tables.clear();
      mem.mode = mode;
      const idOf = (t: string) => RECIPE_ROWS[POOL.findIndex((r) => r.title === t)].id;
      const a = idOf("Synthé : lignes non reconnues"), b = idOf("Synthé : jus de 1 à 2 citrons");
      const st: WeekSettings = { portions: 6, recipes: 2, seasons: ["automne"], excludeDishTypes: [] };
      const status = async () => {
        const { plan, items } = await loadWeek(HH, W0);
        return listStatus(plan!.id, items, RECIPE_ROWS, ING_ROWS, CAT_ROWS);
      };
      const make = async () => {
        const { plan, items } = await loadWeek(HH, W0);
        return generateList(plan!.id, items, RECIPE_ROWS, ING_ROWS, CAT_ROWS);
      };
      const { plan } = await saveWeek(HH, W0, st, [{ id: a, multiplier: 1 }, { id: b, multiplier: 1 }], SERVINGS);
      expect(await status()).toBe("none");
      mem.tables.set("shopping_items", [{ id: "m1", plan_id: plan.id, ingredient_id: null, label: "Café", quantity_text: null, aisle: "autre", pantry: false, manual: true, checked: false, position: 9999 }]);
      expect(await status(), "a manual item alone is no list").toBe("none");
      await make();
      expect(await status()).toBe("current");
      // Same recipes in another order, other portions with the same multipliers: same rows.
      await saveWeek(HH, W0, { ...st, portions: 7 }, [{ id: b, multiplier: 1 }, { id: a, multiplier: 1 }], SERVINGS);
      expect(await status()).toBe("current");
      // Multiplier changed: the quantities change.
      await saveWeek(HH, W0, st, [{ id: a, multiplier: 2 }, { id: b, multiplier: 1 }], SERVINGS);
      expect(await status()).toBe("stale");
      await make();
      expect(await status()).toBe("current");
      // Postponed recipe marked already bought: its lines leave the list.
      await saveWeek(HH, W0, st, [{ id: a, multiplier: 2 }, { id: b, multiplier: 1 }], SERVINGS, new Map([[b, { postponed: true, already_bought: true }]]));
      expect(await status()).toBe("stale");
      await make();
      expect(await status()).toBe("current");
      // Marked postponed only (not bought): no change to the list.
      await saveWeek(HH, W0, st, [{ id: a, multiplier: 2 }, { id: b, multiplier: 1 }], SERVINGS, new Map([[b, { postponed: true, already_bought: true }], [a, { postponed: true, already_bought: false }]]));
      expect(await status()).toBe("current");
      // Recipe removed.
      await saveWeek(HH, W0, st, [{ id: a, multiplier: 2 }], SERVINGS, new Map([[a, { postponed: true, already_bought: false }]]));
      expect(await status()).toBe("current"); // b was already bought: its lines were not on the list
      await saveWeek(HH, W0, st, [{ id: b, multiplier: 1 }], SERVINGS);
      expect(await status()).toBe("stale");
      // Language.
      await make();
      setLang("en");
      try {
        expect(await status()).toBe("stale");
      } finally {
        setLang("fr");
      }
      // Every recipe already bought: the list made is empty, so "none".
      await saveWeek(HH, W0, st, [{ id: b, multiplier: 1 }], SERVINGS, new Map([[b, { postponed: true, already_bought: true }]]));
      expect(await status()).toBe("stale");
      expect(await make()).toBe(0);
      expect(await status()).toBe("none");
    });
  }
});

describe("7. erreurs : repli seulement sur PGRST202, lecture des coches en erreur", () => {
  const setup = async (mode: "rpc" | "fallback") => {
    mem.tables.clear();
    mem.mode = mode;
    mem.fail = null;
    const id = RECIPE_ROWS[POOL.findIndex((r) => r.title === "Synthé : lignes non reconnues")].id;
    const st: WeekSettings = { portions: 4, recipes: 1, seasons: ["automne"], excludeDishTypes: [] };
    const { plan } = await saveWeek(HH, W0, st, [{ id, multiplier: 1 }], SERVINGS);
    const { items } = await loadWeek(HH, W0);
    await generateList(plan.id, items, RECIPE_ROWS, ING_ROWS, CAT_ROWS);
    rowsOf(plan.id)[0].checked = true;
    return { plan, items, st, id };
  };
  afterAll(() => {
    mem.fail = null;
  });
  it("repli : une lecture des coches en erreur arrête generateList, la liste reste telle quelle", async () => {
    const { plan, items } = await setup("fallback");
    const before = snap(rowsOf(plan.id));
    mem.fail = (w) => (w === "shopping_items:select" ? { code: "08006", message: "connexion perdue" } : null);
    await expect(generateList(plan.id, items, RECIPE_ROWS, ING_ROWS, CAT_ROWS)).rejects.toMatchObject({ code: "08006" });
    mem.fail = null;
    expect(snap(rowsOf(plan.id))).toBe(before);
  });
  it("rpc : une autre erreur que PGRST202 est remontée, sans repli", async () => {
    const { plan, items, st, id } = await setup("rpc");
    const before = tableSnap("week_plans", "week_plan_recipes", "shopping_items");
    let stepRequests = 0;
    mem.fail = (w) => {
      if (w.startsWith("rpc:")) return { code: "57014", message: "statement timeout" };
      if (w !== "week_plans:select" && w !== "week_plan_recipes:select") stepRequests++;
      return null;
    };
    await expect(generateList(plan.id, items, RECIPE_ROWS, ING_ROWS, CAT_ROWS)).rejects.toMatchObject({ code: "57014" });
    await expect(saveWeek(HH, W0, st, [{ id, multiplier: 2 }], SERVINGS)).rejects.toMatchObject({ code: "57014" });
    const from = { week: W0, settings: st, planned: [{ id, multiplier: 1 }] };
    await expect(postponeRecipe(HH, from, id, false, st, SERVINGS)).rejects.toMatchObject({ code: "57014" });
    mem.fail = null;
    expect(stepRequests, "requêtes du repli").toBe(0);
    expect(tableSnap("week_plans", "week_plan_recipes", "shopping_items")).toBe(before);
  });
});
