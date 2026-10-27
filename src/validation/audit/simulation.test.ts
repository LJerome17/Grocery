// Randomised simulation of the week page (src/app/semaine/page.tsx) and the list page (src/app/liste/page.tsx).
// Thousands of sessions (one household, "this week" W and "next week" W+1, random rules and history) run random
// user operations through a faithful re-implementation of the page handlers, which call the REAL library code
// (planner.ts, weekPlan.ts, data.ts, shopping.ts) against an in-memory fake of the Supabase client. Invariants are
// checked after every operation. Read-only on the app: nothing outside src/validation/audit/ is changed.
//
// Each session picks at random whether migration 0015 is applied (rpc save_weeks / replace_list answer) or not
// (they answer PGRST202 and weekPlan.ts saves step by step). Saves are randomly cut by a lost connection on one
// request: on the rpc path nothing may change; on the step-by-step path partial states are expected (recorded).
//
// Run: npx vitest run src/validation/audit/simulation.test.ts
//   SIM_SESSIONS=n   number of sessions (default 4000)
//   SIM_SEED=n       replay one session, printing every operation

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// ====================================================================================== 1. fake Supabase client
// Covers exactly what weekPlan.ts, data.ts (loadHistory) and liste/page.tsx use, with PostgREST semantics:
// - insert/upsert of an array sends `columns=` (union of keys): a column missing from one row becomes NULL unless
//   `defaultToNull: false` (Prefer: missing=default); NOT NULL violations fail the whole statement (23502);
// - upsert(onConflict) = INSERT ... ON CONFLICT DO UPDATE of the payload columns only (the id is kept);
// - returning rows only with .select(); .single() needs exactly one row, .maybeSingle() at most one;
// - int columns refuse non-integers (22P02); unknown columns fail (PGRST204); plan_id must exist (23503);
// - rpc("save_weeks") / rpc("replace_list"): the plpgsql of supabase/migrations/0015_atomic_saves.sql, run as one
//   transaction (any error rolls every statement back); when the migration is "not applied" they answer PGRST202.
// Fault injection: arm(k, during) makes the k-th request from now fail with a lost connection. A failed table
// request does nothing; a failed rpc either never reaches the database or (during > 0) is cut after `during`
// statements of its transaction, which is then rolled back (no commit happened).
const fake = vi.hoisted(() => {
  type Row = Record<string, unknown>;
  /** since: the migration that adds the column (absent before: 42703 / PGRST204, left out of "*"). */
  type Col = { notNull: boolean; def?: () => unknown; int?: boolean; since?: number };
  type Res = { data: unknown; error: unknown };
  let counter = 0;
  const uuid = () => `00000000-0000-4000-8000-${(++counter).toString(16).padStart(12, "0")}`;
  const SCHEMA: Record<string, { cols: Record<string, Col>; unique?: string[] }> = {
    week_plans: {
      cols: {
        id: { notNull: true, def: uuid },
        household_id: { notNull: true },
        week_start: { notNull: true },
        suppers: { notNull: true, def: () => 5, int: true },
        people: { notNull: true, def: () => 2, int: true },
        lunches: { notNull: true, def: () => 2, int: true },
        store: { notNull: true, def: () => "maxi" },
        created_at: { notNull: true, def: () => "2026-01-01T00:00:00Z" },
        portions: { notNull: true, def: () => 20, int: true },
        seasons: { notNull: false },
        exclude_dish_types: { notNull: true, def: () => [] },
        list_signature: { notNull: false, since: 16 },
      },
      unique: ["household_id", "week_start"],
    },
    week_plan_recipes: {
      cols: {
        id: { notNull: true, def: uuid },
        plan_id: { notNull: true },
        recipe_id: { notNull: true },
        portions: { notNull: true },
        position: { notNull: true, def: () => 0, int: true },
        cooked: { notNull: true, def: () => false },
        multiplier: { notNull: true, def: () => 1, int: true },
        postponed: { notNull: true, def: () => false },
        already_bought: { notNull: true, def: () => false },
      },
    },
    shopping_items: {
      cols: {
        id: { notNull: true, def: uuid },
        plan_id: { notNull: true },
        ingredient_id: { notNull: false },
        label: { notNull: true },
        quantity_text: { notNull: false },
        aisle: { notNull: true, def: () => "autre" },
        pantry: { notNull: true, def: () => false },
        manual: { notNull: true, def: () => false },
        checked: { notNull: true, def: () => false },
        position: { notNull: true, def: () => 0, int: true },
      },
    },
  };
  const tables: Record<string, Row[]> = { week_plans: [], week_plan_recipes: [], shopping_items: [] };
  const stats = { statements: 0, rpc: {} as Record<string, number> };
  const ctl = {
    /** Migrations applied: 0 (neither), 15 (save_weeks, replace_list), 16 (+ make_list, week_plans.list_signature). */
    level: 16,
    fault: null as null | { countdown: number; during: number; fired: string | null },
    /** Inside an rpc transaction: statements are not requests (no fault, the fault is on the rpc itself). */
    inner: false,
    innerFailAt: 0,
  };
  const clone = <T,>(v: T): T => structuredClone(v);
  const pgErr = (code: string, message: string) => ({ code, message, details: null, hint: null });
  const bump = (k: string) => (stats.rpc[k] = (stats.rpc[k] ?? 0) + 1);
  /** The column exists at the current migration level. */
  const has = (table: string, c: string) => {
    const spec = SCHEMA[table].cols[c];
    return !!spec && (!spec.since || ctl.level >= spec.since);
  };

  /** A lost connection on this request, when armed and due. */
  function connLost(where: string) {
    if (ctl.inner || !ctl.fault || ctl.fault.fired) return null;
    if (--ctl.fault.countdown > 0) return null;
    ctl.fault.fired = where;
    return pgErr("08006", `fake: connection lost (${where})`);
  }

  type Filter = { kind: "eq" | "lt" | "in"; col: string; v: unknown };
  const match = (r: Row, f: Filter[]) =>
    f.every((x) => (x.kind === "eq" ? r[x.col] === x.v : x.kind === "lt" ? String(r[x.col]) < String(x.v) : (x.v as unknown[]).includes(r[x.col])));

  /** "*", "a,b", "week_start, week_plan_recipes(recipe_id)". */
  function project(table: string, row: Row, cols: string): Row {
    const parts: string[] = [];
    let depth = 0,
      cur = "";
    for (const ch of cols) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
      if (ch === "," && depth === 0) {
        parts.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    if (cur.trim()) parts.push(cur.trim());
    const out: Row = {};
    for (const p of parts) {
      const m = /^(\w+)\((.*)\)$/.exec(p);
      if (p === "*") Object.assign(out, clone(row));
      else if (m) {
        if (table !== "week_plans" || m[1] !== "week_plan_recipes") throw new Error(`fake: embed ${p} on ${table} not supported`);
        out[m[1]] = tables.week_plan_recipes.filter((c) => c.plan_id === row.id).map((c) => project("week_plan_recipes", c, m[2]));
      } else {
        if (!(p in SCHEMA[table].cols)) throw new Error(`fake: unknown column ${p}`);
        if (!has(table, p)) throw pgErr("42703", `column ${table}.${p} does not exist`);
        out[p] = clone(row[p]);
      }
    }
    return out;
  }

  class Query {
    private op: "select" | "insert" | "upsert" | "update" | "delete" = "select";
    private filters: Filter[] = [];
    private orders: { col: string; asc: boolean }[] = [];
    private lim: number | null = null;
    private cols: string | null = null;
    private returning = false;
    private mode: "many" | "single" | "maybe" = "many";
    private values: Row[] = [];
    private columns: string[] | null = null;
    private missingDefault = false;
    private onConflict: string[] | null = null;
    private patch: Row = {};
    constructor(private table: string) {
      if (!SCHEMA[table]) throw new Error(`fake: table ${table} not covered`);
    }
    select(cols = "*") {
      if (this.op === "select") this.cols = cols;
      else {
        this.returning = true;
        this.cols = cols;
      }
      return this;
    }
    private write(op: "insert" | "upsert", values: Row | Row[], o: { defaultToNull?: boolean; onConflict?: string } = {}) {
      this.op = op;
      this.values = clone(Array.isArray(values) ? values : [values]);
      // postgrest-js: `columns` only for arrays (index.mjs insert/upsert); a single object = its own keys.
      this.columns = Array.isArray(values) ? [...new Set(values.flatMap((v) => Object.keys(v)))] : null;
      this.missingDefault = o.defaultToNull === false;
      this.onConflict = o.onConflict ? o.onConflict.split(",").map((s) => s.trim()) : null;
      return this;
    }
    insert(values: Row | Row[], o: { defaultToNull?: boolean } = {}) {
      return this.write("insert", values, o);
    }
    upsert(values: Row | Row[], o: { onConflict?: string; defaultToNull?: boolean } = {}) {
      return this.write("upsert", values, o);
    }
    update(patch: Row) {
      this.op = "update";
      this.patch = clone(patch);
      return this;
    }
    delete() {
      this.op = "delete";
      return this;
    }
    eq(col: string, v: unknown) {
      this.filters.push({ kind: "eq", col, v });
      return this;
    }
    lt(col: string, v: unknown) {
      this.filters.push({ kind: "lt", col, v });
      return this;
    }
    in(col: string, v: unknown[]) {
      this.filters.push({ kind: "in", col, v });
      return this;
    }
    order(col: string, o: { ascending?: boolean } = {}) {
      this.orders.push({ col, asc: o.ascending !== false });
      return this;
    }
    limit(n: number) {
      this.lim = n;
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
    then<A, B>(res: (v: Res) => A, rej?: (e: unknown) => B) {
      let out: Res;
      try {
        const lost = connLost(`${this.op} ${this.table}`);
        out = lost ? { data: null, error: lost } : this.exec();
      } catch (e) {
        // A database error (missing column) is an error response; anything else is a harness bug.
        if (e && typeof e === "object" && "code" in e) return Promise.resolve({ data: null, error: e }).then(res, rej);
        return Promise.reject(e).then(res, rej);
      }
      return Promise.resolve(out).then(res, rej);
    }
    private build(v: Row): Row | { error: unknown } {
      const schema = SCHEMA[this.table].cols;
      for (const k of Object.keys(v)) if (!has(this.table, k)) return { error: pgErr("PGRST204", `Could not find the '${k}' column`) };
      const row: Row = {};
      for (const [c, spec] of Object.entries(schema)) {
        if (!has(this.table, c)) continue;
        const sent = this.columns ? this.columns.includes(c) : c in v;
        if (sent && c in v) row[c] = v[c];
        else if (sent && !this.missingDefault) row[c] = null; // columns= without missing=default: NULL
        else row[c] = spec.def ? spec.def() : null;
        if (row[c] === undefined) row[c] = null;
        if (row[c] === null && spec.notNull) return { error: pgErr("23502", `null value in column "${c}" of relation "${this.table}" violates not-null constraint`) };
        if (spec.int && row[c] !== null && !Number.isInteger(row[c])) return { error: pgErr("22P02", `invalid input syntax for type integer: "${row[c]}"`) };
      }
      if ("plan_id" in schema && !tables.week_plans.some((p) => p.id === row.plan_id)) return { error: pgErr("23503", "foreign key violation") };
      return row;
    }
    private finish(rows: Row[]): Res {
      let data: Row[] = rows;
      for (const o of [...this.orders].reverse()) data = [...data].sort((a, b) => (a[o.col]! < b[o.col]! ? -1 : a[o.col]! > b[o.col]! ? 1 : 0) * (o.asc ? 1 : -1));
      if (this.lim !== null) data = data.slice(0, this.lim);
      const projected = data.map((r) => project(this.table, r, this.cols ?? "*"));
      if (this.mode === "single") {
        if (projected.length !== 1) return { data: null, error: pgErr("PGRST116", `JSON object requested, ${projected.length} rows returned`) };
        return { data: projected[0], error: null };
      }
      if (this.mode === "maybe") {
        if (projected.length > 1) return { data: null, error: pgErr("PGRST116", "multiple rows returned") };
        return { data: projected[0] ?? null, error: null };
      }
      return { data: projected, error: null };
    }
    /** Runs the statement now (also used for the statements inside an rpc transaction). */
    exec(): Res {
      stats.statements++;
      const t = tables[this.table];
      if (this.op === "select") return this.finish(t.filter((r) => match(r, this.filters)));
      if (this.op === "insert" || this.op === "upsert") {
        const built: Row[] = [];
        for (const v of this.values) {
          const r = this.build(v);
          if ("error" in r && Object.keys(r).length === 1) return { data: null, error: r.error };
          built.push(r as Row);
        }
        const unique = SCHEMA[this.table].unique;
        const out: Row[] = [];
        const pending: Row[] = [];
        for (const r of built) {
          const conflictCols = this.onConflict ?? unique;
          const existing = conflictCols && [...t, ...pending].find((x) => conflictCols.every((c) => x[c] === r[c]));
          if (existing && this.op === "upsert") {
            // ON CONFLICT DO UPDATE SET <payload columns> (merge-duplicates): the id and other columns stay.
            const sentCols = this.columns ?? Object.keys(this.values[built.indexOf(r)]);
            for (const c of sentCols) if (c !== "id") existing[c] = r[c];
            out.push(existing);
          } else if (existing && unique) {
            return { data: null, error: pgErr("23505", "duplicate key value violates unique constraint") };
          } else {
            pending.push(r);
            out.push(r);
          }
        }
        t.push(...pending);
        return this.returning ? this.finish(out) : { data: null, error: null };
      }
      if (this.op === "update") {
        const hit = t.filter((r) => match(r, this.filters));
        for (const r of hit) Object.assign(r, clone(this.patch));
        return this.returning ? this.finish(hit) : { data: null, error: null };
      }
      // delete (cascade: week_plans -> week_plan_recipes, shopping_items)
      const hit = t.filter((r) => match(r, this.filters));
      tables[this.table] = t.filter((r) => !hit.includes(r));
      if (this.table === "week_plans") {
        const ids = new Set(hit.map((p) => p.id));
        tables.week_plan_recipes = tables.week_plan_recipes.filter((r) => !ids.has(r.plan_id));
        tables.shopping_items = tables.shopping_items.filter((r) => !ids.has(r.plan_id));
      }
      return this.returning ? this.finish(hit) : { data: null, error: null };
    }
  }

  // ---------------------------------------------------------------- 0015_atomic_saves.sql
  /** One statement of the transaction: raises when the armed fault cuts the transaction here. */
  function stmt(q: Query): Res {
    if (ctl.innerFailAt && --ctl.innerFailAt === 0) throw pgErr("08006", "fake: connection lost inside the transaction");
    const r = q.exec();
    if (r.error) throw r.error; // plpgsql: an error aborts the function, the transaction rolls back
    return r;
  }
  type J = Record<string, unknown>;
  /** jsonb_array_elements(coalesce(x, '[]')): JSON null (not SQL NULL) is a scalar, which raises. */
  const elems = (v: unknown, what: string): unknown[] => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw pgErr("22023", `cannot extract elements from a scalar (${what})`);
    return v;
  };
  function saveWeeksSql(a: J): unknown[] {
    const result: unknown[] = [];
    for (const w of elems(a.p_weeks, "p_weeks") as J[]) {
      // insert ... on conflict (household_id, week_start) do update set suppers, portions, seasons, exclude_dish_types
      const plan = stmt(
        new Query("week_plans")
          .upsert(
            {
              household_id: a.p_household ?? null,
              week_start: w.week_start ?? null,
              suppers: w.suppers ?? null,
              portions: w.portions ?? null,
              seasons: elems(w.seasons, "seasons").map(String),
              exclude_dish_types: elems(w.exclude_dish_types, "exclude_dish_types").map(String),
            },
            { onConflict: "household_id,week_start" },
          )
          .select("*")
          .single(),
      ).data as J;
      const pid = plan.id;
      stmt(new Query("week_plan_recipes").delete().eq("plan_id", pid));
      const rows = (elems(w.recipes, "recipes") as J[]).map((r) => ({
        plan_id: pid,
        recipe_id: r.recipe_id ?? null,
        position: r.position ?? null,
        multiplier: r.multiplier ?? null,
        portions: r.portions ?? null,
        postponed: r.postponed ?? false, // coalesce((r->>'postponed')::boolean, false)
        already_bought: r.already_bought ?? false,
      }));
      if (rows.length) stmt(new Query("week_plan_recipes").insert(rows, { defaultToNull: false }));
      result.push({
        plan: stmt(new Query("week_plans").select("*").eq("id", pid).single()).data,
        items: stmt(new Query("week_plan_recipes").select("*").eq("plan_id", pid).order("position")).data,
      });
    }
    return result;
  }
  function replaceListSql(a: J): number {
    const plan = a.p_plan;
    const key = (ingredientId: unknown, label: unknown) => (ingredientId === null || ingredientId === undefined || ingredientId === "" ? `label:${label}` : String(ingredientId));
    const ticked = (stmt(new Query("shopping_items").select("ingredient_id,label,checked,manual").eq("plan_id", plan)).data as J[])
      .filter((r) => r.checked === true && r.manual === false)
      .map((r) => key(r.ingredient_id, r.label));
    stmt(new Query("shopping_items").delete().eq("plan_id", plan).eq("manual", false));
    const rows = (elems(a.p_rows, "p_rows") as J[]).map((r) => ({
      plan_id: plan,
      ingredient_id: r.ingredient_id === "" ? null : (r.ingredient_id ?? null),
      label: r.label ?? null,
      quantity_text: r.quantity_text ?? null,
      aisle: r.aisle ?? null,
      pantry: r.pantry ?? false,
      manual: false,
      checked: r.label === null || r.label === undefined ? null : ticked.includes(key(r.ingredient_id, r.label)),
      position: r.position ?? null,
    }));
    if (rows.length) stmt(new Query("shopping_items").insert(rows, { defaultToNull: false }));
    return rows.length; // get diagnostics n = row_count
  }
  /** 0016: replace_list + the fingerprint, same transaction; 'plan introuvable' when the plan does not exist. */
  function makeListSql(a: J): number {
    const n = replaceListSql(a);
    const hit = stmt(new Query("week_plans").update({ list_signature: a.p_signature ?? null }).eq("id", a.p_plan).select("id")).data as J[];
    if (!hit.length) throw pgErr("P0001", "plan introuvable");
    return n;
  }
  function runRpc(fn: string, rawArgs: unknown): Res {
    const lost = connLost(`rpc ${fn}`);
    const exists = (fn === "make_list" && ctl.level >= 16) || ((fn === "save_weeks" || fn === "replace_list") && ctl.level >= 15);
    const during = lost && exists ? ctl.fault!.during : 0;
    if (lost && !during) {
      bump(`${fn}:lost-before`);
      return { data: null, error: lost };
    }
    if (!exists) {
      bump(`${fn}:missing`);
      return { data: null, error: pgErr("PGRST202", `Could not find the function public.${fn} in the schema cache`) };
    }
    const args = JSON.parse(JSON.stringify(rawArgs ?? {})) as J; // sent as JSON
    const snapshot = clone(tables);
    ctl.inner = true;
    ctl.innerFailAt = during;
    try {
      const data = fn === "save_weeks" ? saveWeeksSql(args) : fn === "replace_list" ? replaceListSql(args) : makeListSql(args);
      // A cut transaction never commits, even if every statement ran.
      if (lost) throw lost;
      bump(`${fn}:ok`);
      return { data: JSON.parse(JSON.stringify(data)), error: null };
    } catch (e) {
      for (const k of Object.keys(tables)) tables[k] = snapshot[k];
      bump(`${fn}:${lost ? "lost-during" : "sql-error"}`);
      return { data: null, error: lost ?? e };
    } finally {
      ctl.inner = false;
      ctl.innerFailAt = 0;
    }
  }
  const client = {
    from: (table: string) => new Query(table),
    rpc: (fn: string, args?: unknown) => ({
      then<A, B>(res: (v: Res) => A, rej?: (e: unknown) => B) {
        let out: Res;
        try {
          out = runRpc(fn, args);
        } catch (e) {
          return Promise.reject(e).then(res, rej);
        }
        return Promise.resolve(out).then(res, rej);
      },
    }),
  };
  return {
    client,
    tables,
    stats,
    ctl,
    reset(level: 0 | 15 | 16 = 16) {
      counter = 0;
      for (const k of Object.keys(tables)) tables[k] = [];
      ctl.level = level;
      ctl.fault = null;
    },
    /** The k-th request from now fails (during > 0: an rpc is cut after `during` statements). */
    arm(k: number, during = 0) {
      ctl.fault = { countdown: k, during, fired: null };
    },
    /** Disarms; returns the request that failed, if any. */
    disarm(): string | null {
      const f = ctl.fault?.fired ?? null;
      ctl.fault = null;
      return f;
    },
    uuid,
  };
});

vi.mock("../../lib/supabase", () => ({ supabase: () => fake.client, SUPABASE_URL: "http://fake", SUPABASE_KEY: "fake" }));

import { NO_AISLE } from "../../lib/aisles";
import { loadHistory, toPlannerRecipes } from "../../lib/data";
import { DISH_TYPES, type Ingredient, type Recipe, type RecipeIngredient, type ShoppingItem, type WeekPlan, type WeekPlanRecipe } from "../../lib/db";
import { setLang, tr } from "../../lib/i18n";
import {
  DEFAULT_SERVINGS,
  fitMultipliers,
  NOT_A_MEAL,
  passesFilters,
  planWeek,
  respectsRules,
  seasonOf,
  swapInPlan,
  weekStart,
  type Filters,
  type Planned,
  type PlannerRecipe,
  type Rules,
  type Season,
} from "../../lib/planner";
import { buildShoppingList, type CatalogItem } from "../../lib/shopping";
import {
  fixedOf,
  flagsOf,
  generateList,
  listOrder,
  listRows,
  listStatus,
  loadWeek,
  nextWeekOf,
  postponeRecipe,
  saveWeek,
  saveWeeks,
  servingsOf,
  type PostponeFlags,
  type WeekSettings,
} from "../../lib/weekPlan";

// ====================================================================================== 2. real recipe data
// Same construction as src/validation/grocery.test.ts (catalog id = catalogue name, full Ingredient rows) and
// src/validation/planner.test.ts (Recipe rows from public/starter/recipes.json, which already carries the
// data/recipe-meta.json dish_type / protein / seasons). Synthetic additions, marked zz-: a side dish
// (NOT_A_MEAL) and an inactive recipe (both must never be suggested nor pickable), and a recipe with an
// uncatalogued line and an optional uncatalogued line (exercises the `label:` key of the ticked set).
const ROOT = join(__dirname, "..", "..", "..");
type SIng = { position: number; raw: string; quantity: number | null; quantity_max: number | null; unit: string | null; name: string; note?: string | null; optional: boolean; catalog: string | null };
type SRecipe = { slug: string; title: string; servings: number | null; dish_type: string | null; protein: string | null; seasons: string[]; ingredients: SIng[] };
type CatEntry = { name: string; name_en: string; aisle: string; pantry?: boolean; count_unit?: string; equiv?: Ingredient["equiv"]; ml_per_can?: number; cooked_ratio?: number };
const STARTER: SRecipe[] = JSON.parse(readFileSync(join(ROOT, "public", "starter", "recipes.json"), "utf8"));
const CAT: CatEntry[] = JSON.parse(readFileSync(join(ROOT, "data", "catalog.json"), "utf8")).ingredients;
const CATALOG: Ingredient[] = CAT.map((c) => ({ id: c.name, household_id: null, name: c.name, name_en: c.name_en, aisle: c.aisle, pantry: !!c.pantry, count_unit: c.count_unit ?? null, equiv: c.equiv ?? null, ml_per_can: c.ml_per_can ?? null, cooked_ratio: c.cooked_ratio ?? null }));
const CAT_BY_ID = new Map(CATALOG.map((c) => [c.id, c]));
const ALL_SEASONS: Season[] = ["printemps", "ete", "automne", "hiver"];
const BASE_RECIPES: Recipe[] = STARTER.map((s) => ({
  id: s.slug, household_id: "book", title: s.title, source_type: "url", source_url: null, image_url: null, servings: s.servings,
  total_minutes: null, instructions: [], notes: null, dish_type: s.dish_type, protein: s.protein, seasons: s.seasons, rating: null, active: true,
}));
const INGREDIENTS: RecipeIngredient[] = STARTER.flatMap((s) =>
  s.ingredients.map((i, k) => ({ id: `${s.slug}-${k}`, recipe_id: s.slug, position: i.position, section: null, raw: i.raw, quantity: i.quantity, quantity_max: i.quantity_max, unit: i.unit, name: i.name, note: i.note ?? null, optional: i.optional, ingredient_id: i.catalog })),
);
BASE_RECIPES.push({ ...BASE_RECIPES[0], id: "zz-accompagnement", title: "Accompagnement test", dish_type: "accompagnement", protein: null, seasons: ALL_SEASONS });
BASE_RECIPES.push({ ...BASE_RECIPES[0], id: "zz-inactive", title: "Inactive test", dish_type: "bol", protein: "tofu", seasons: ALL_SEASONS, active: false });
BASE_RECIPES.push({ ...BASE_RECIPES[0], id: "zz-maison", title: "Plat maison test", servings: null, dish_type: "bol", protein: "tofu", seasons: ALL_SEASONS });
INGREDIENTS.push(
  { id: "zz-maison-0", recipe_id: "zz-maison", position: 0, section: null, raw: "200 g truc maison", quantity: 200, quantity_max: null, unit: "g", name: "Truc maison", note: null, optional: false, ingredient_id: null },
  { id: "zz-maison-1", recipe_id: "zz-maison", position: 1, section: null, raw: "persil (facultatif)", quantity: null, quantity_max: null, unit: null, name: "Garniture maison", note: null, optional: true, ingredient_id: null },
  { id: "zz-maison-2", recipe_id: "zz-maison", position: 2, section: null, raw: "1 bloc de tofu ferme", quantity: 1, quantity_max: null, unit: "block", name: "tofu ferme", note: null, optional: false, ingredient_id: "Tofu ferme" },
  { id: "zz-maison-3", recipe_id: "zz-maison", position: 3, section: null, raw: "Jus de 1 citron", quantity: 1, quantity_max: null, unit: null, name: "Jus de citron", note: "jus", optional: false, ingredient_id: "Citron" },
);
const JUICE_OF: Record<string, string> = { Citron: "Jus de citron", Lime: "Jus de lime" };
const ING_BY_RECIPE = new Map<string, RecipeIngredient[]>();
for (const i of INGREDIENTS) ING_BY_RECIPE.set(i.recipe_id, [...(ING_BY_RECIPE.get(i.recipe_id) ?? []), i]);

// ====================================================================================== helpers
function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const addWeeks = (week: string, k: number) => {
  const [y, m, d] = week.split("-").map(Number);
  return ymd(new Date(y, m - 1, d + 7 * k));
};

/** Independent optimum of extra portions + 2 per extra multiple, reaching >= target (unbounded covering knapsack). */
function optimalCost(servings: number[], target: number): number {
  const s = servings.map((x) => (x > 0 ? x : DEFAULT_SERVINGS));
  const base = s.reduce((a, b) => a + b, 0);
  const rem = Math.max(0, target - base);
  const f = [0];
  for (let r = 1; r <= rem; r++) f.push(Math.min(...s.map((x) => f[Math.max(0, r - x)] + x + 2)));
  return base - target + f[rem];
}
const costOf = (servings: number[], mult: number[], target: number) =>
  servings.reduce((a, s, i) => a + s * mult[i], 0) - target + mult.reduce((a, m) => a + (m - 1) * 2, 0);

// ====================================================================================== 3. page re-implementation
const HH = "hh-1";
type Kitchen = { recipes: Recipe[]; ingredients: RecipeIngredient[]; catalog: Ingredient[] };
type Page = {
  offset: 0 | 1;
  week: string;
  season: Season;
  settings: WeekSettings;
  items: WeekPlanRecipe[];
  planId: string | null;
  history: Map<string, number>;
  swappedAway: string[];
  error: string | null;
  planner: PlannerRecipe[];
};
type Ctx = { kitchen: Kitchen; rules: Rules; recipeById: Map<string, Recipe>; thisWeek: string };

// page.tsx 155: sv(id) = servingsOf(recipeById.get(id))
const svOf = (ctx: Ctx) => (id: string) => servingsOf(ctx.recipeById.get(id));
// page.tsx 159-163: filters, current, fixed (postponed recipes with their multiplier), fixedList
const filtersOf = (p: Page): Filters => ({ seasons: p.settings.seasons, excludeDishTypes: p.settings.excludeDishTypes });
const currentOf = (p: Page): Planned[] => p.items.map((i) => ({ id: i.recipe_id, multiplier: i.multiplier || 1 }));
const fixedListOf = (p: Page): Planned[] => [...fixedOf(p.items)].map(([id, multiplier]) => ({ id, multiplier }));

/** page.tsx 98-153: week of the offset, loadWeek + loadHistory, settings from the plan (settingsOf 75-82) or defaults; 150-153 planner. */
async function loadPage(ctx: Ctx, offset: 0 | 1): Promise<Page> {
  const week = offset === 0 ? ctx.thisWeek : nextWeekOf(ctx.thisWeek);
  const season = seasonOf(new Date(`${week}T12:00:00`)); // page.tsx 101
  const [w, h] = await Promise.all([loadWeek(HH, week), loadHistory(HH, week)]);
  const settings: WeekSettings = w.plan
    ? settingsOf(w.plan, week)
    : { portions: 20, recipes: 5, seasons: [seasonOf(new Date(`${week}T12:00:00`))], excludeDishTypes: [] };
  return {
    offset, week, season, settings, items: w.items, planId: w.plan?.id ?? null, history: h, swappedAway: [], error: null,
    planner: toPlannerRecipes(ctx.kitchen.recipes, ctx.kitchen.ingredients, ctx.kitchen.catalog, h),
  };
}

/** page.tsx 75-82 */
const settingsOf = (plan: WeekPlan, week: string): WeekSettings => ({
  portions: plan.portions ?? 20,
  recipes: plan.suppers,
  seasons: plan.seasons ?? [seasonOf(new Date(`${week}T12:00:00`))],
  excludeDishTypes: plan.exclude_dish_types ?? [],
});
/** page.tsx 198-208: after a failed save, show the week as the database has it (a second failure is ignored). */
async function resync(p: Page) {
  try {
    const w = await loadWeek(HH, p.week);
    p.planId = w.plan?.id ?? null;
    p.items = w.items;
    if (w.plan) p.settings = settingsOf(w.plan, p.week);
  } catch {
    /* still offline: the error is already shown */
  }
}
/** page.tsx 179-196 (catch: resync, 192). Returns whether it saved. */
async function persist(ctx: Ctx, p: Page, planned: Planned[], s = p.settings, flags = flagsOf(p.items)): Promise<boolean> {
  p.error = null;
  try {
    const saved = await saveWeek(HH, p.week, s, planned, svOf(ctx), flags);
    p.planId = saved.plan.id;
    p.items = saved.items;
    return true;
  } catch (e) {
    p.error = `persist: ${JSON.stringify(e)}`;
    await resync(p);
    return false;
  }
}
/** page.tsx 211: multipliers refitted, postponed recipes keep theirs. */
const refit = (ctx: Ctx, p: Page, ids: string[], portions: number): Planned[] => fitMultipliers(ids, svOf(ctx), portions, fixedOf(p.items));
/** page.tsx 213-218 */
async function suggestAll(ctx: Ctx, p: Page, s = p.settings) {
  const plan = planWeek(p.planner, s.recipes, s.portions, ctx.rules, p.season, { fixed: fixedListOf(p), filters: { seasons: s.seasons, excludeDishTypes: s.excludeDishTypes } });
  if (!plan.length) {
    p.error = "Aucune recette ne correspond aux catégories choisies.";
    return { plan, saved: false };
  }
  return { plan, saved: await persist(ctx, p, plan, s) };
}
/** page.tsx 220-234 */
async function changeSettings(ctx: Ctx, p: Page, next: WeekSettings) {
  const current = currentOf(p);
  const prev = p.settings;
  p.settings = next; // setSettings(next)
  if (!current.length) return { kind: "none" as const };
  if (next.recipes !== prev.recipes || next.portions !== prev.portions) {
    const plan = planWeek(p.planner, next.recipes, next.portions, ctx.rules, p.season, {
      keep: current.map((x) => x.id),
      fixed: fixedListOf(p),
      filters: { seasons: next.seasons, excludeDishTypes: next.excludeDishTypes },
    });
    const chosen = plan.length ? plan : refit(ctx, p, current.map((x) => x.id), next.portions);
    return { kind: "replan" as const, fallback: !plan.length, saved: await persist(ctx, p, chosen, next) };
  }
  return { kind: "filters" as const, saved: await persist(ctx, p, current, next) };
}
/** page.tsx 236-241 */
async function swap(ctx: Ctx, p: Page, recipeId: string) {
  const current = currentOf(p);
  const next = swapInPlan(p.planner, current, recipeId, p.settings.portions, ctx.rules, p.season, { avoid: p.swappedAway, filters: filtersOf(p), fixed: fixedOf(p.items) });
  if (!next) {
    p.error = "Aucune autre recette ne convient";
    return null;
  }
  p.swappedAway = [...p.swappedAway, recipeId];
  await persist(ctx, p, next);
  return next;
}
/** page.tsx 243 */
const remove = (ctx: Ctx, p: Page, recipeId: string) =>
  persist(ctx, p, refit(ctx, p, currentOf(p).filter((x) => x.id !== recipeId).map((x) => x.id), p.settings.portions));
/** page.tsx 245-252 */
async function add(ctx: Ctx, p: Page, recipeId: string) {
  const ids = [...currentOf(p).map((x) => x.id), recipeId];
  const s = { ...p.settings, recipes: Math.max(p.settings.recipes, ids.length) };
  p.settings = s;
  return persist(ctx, p, refit(ctx, p, ids, s.portions), s);
}
/** page.tsx 258-277: both weeks in one save (postponeRecipe); the page then shows r.from. */
async function postpone(ctx: Ctx, p: Page, recipeId: string, bought: boolean): Promise<"ok" | "already" | "error"> {
  const current = currentOf(p);
  if (!current.some((x) => x.id === recipeId)) return "error";
  p.error = null;
  try {
    const r = await postponeRecipe(HH, { week: p.week, settings: p.settings, planned: current, flags: flagsOf(p.items) }, recipeId, bought, p.settings, svOf(ctx));
    if (r === "already") {
      p.error = "Cette recette est déjà prévue la semaine suivante.";
      return "already";
    }
    p.planId = r.from.plan.id;
    p.items = r.from.items;
    return "ok";
  } catch (e) {
    p.error = `postpone: ${JSON.stringify(e)}`;
    await resync(p); // page.tsx 274
    return "error";
  }
}
/** page.tsx 280-284 */
async function setBought(ctx: Ctx, p: Page, recipeId: string, bought: boolean) {
  const flags = flagsOf(p.items);
  flags.set(recipeId, { ...flags.get(recipeId), already_bought: bought } as PostponeFlags);
  return persist(ctx, p, currentOf(p), p.settings, flags);
}
/** page.tsx 286-287 */
const setMultiplier = (ctx: Ctx, p: Page, recipeId: string, multiplier: number) =>
  persist(ctx, p, currentOf(p).map((x) => (x.id === recipeId ? { ...x, multiplier: Math.max(1, multiplier) } : x)));
/** page.tsx 289-299 (an error is shown, the page stays). */
async function makeList(ctx: Ctx, p: Page) {
  if (!p.planId) return false;
  try {
    await generateList(p.planId, p.items, ctx.kitchen.recipes, ctx.kitchen.ingredients, ctx.kitchen.catalog);
    return true;
  } catch (e) {
    p.error = `makeList: ${JSON.stringify(e)}`;
    return false;
  }
}
/** page.tsx 303-305 (search aside) */
const pickable = (ctx: Ctx, p: Page) => ctx.kitchen.recipes.filter((r) => !p.items.some((i) => i.recipe_id === r.id) && r.active && !NOT_A_MEAL.has(r.dish_type ?? ""));
const dishTypesOf = (ctx: Ctx) => DISH_TYPES.filter((d) => !NOT_A_MEAL.has(d) && ctx.kitchen.recipes.some((r) => r.dish_type === d));
const toggleIn = (list: string[], v: string) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
/** page.tsx 177 */
const availableOf = (p: Page) => p.planner.filter((r) => r.active !== false && !NOT_A_MEAL.has(r.dishType ?? "") && passesFilters(r, filtersOf(p))).length;
/** page.tsx 166-176: the banner state ("none" | "current" | "stale") for the shown week. */
const listStatusOf = (ctx: Ctx, planId: string, items: WeekPlanRecipe[]) => listStatus(planId, items, ctx.kitchen.recipes, ctx.kitchen.ingredients, ctx.kitchen.catalog);

// ---------------------------------------------------------------- liste/page.tsx
type ListeView = { planId: string | null; planWeek: string | null; items: ShoppingItem[]; empty: boolean; ordered: { id: string; week_start: string }[] };
/** liste/page.tsx 39-80 (+ 196: the empty state hides the add form). */
async function listeLoad(thisWeek: string, requested: string | null, wanted: string | null): Promise<ListeView> {
  const sb = fake.client;
  const { data: plans, error } = await sb.from("week_plans").select("id, week_start").eq("household_id", HH).order("week_start", { ascending: false }).limit(6);
  if (error) throw error;
  const ps = (plans ?? []) as { id: string; week_start: string }[];
  if (wanted) {
    const p = ps.find((x) => x.week_start === wanted);
    const { data } = p ? await sb.from("shopping_items").select("*").eq("plan_id", p.id).order("position") : { data: [] };
    const items = (data ?? []) as ShoppingItem[];
    return { planId: p?.id ?? null, planWeek: wanted, items, empty: !p || !items.length, ordered: [] };
  }
  const ordered = listOrder(ps, requested, thisWeek);
  for (const p of ordered) {
    const { data } = await sb.from("shopping_items").select("*").eq("plan_id", p.id).order("position");
    if ((data as unknown[])?.length) return { planId: p.id, planWeek: p.week_start, items: data as ShoppingItem[], empty: false, ordered };
  }
  return { planId: ordered[0]?.id ?? null, planWeek: ordered[0]?.week_start ?? null, items: [], empty: !ordered[0], ordered };
}
/** liste/page.tsx 115-123 */
const listeToggle = (item: ShoppingItem) => fake.client.from("shopping_items").update({ checked: !item.checked }).eq("id", item.id);
/** liste/page.tsx 125-140 */
const listeAdd = (planId: string, label: string) =>
  fake.client.from("shopping_items").insert({ plan_id: planId, label: label.trim(), aisle: "autre", manual: true, position: 9999 }).select("*").single();
/** liste/page.tsx 142-149 (the ✕ is only shown on manual rows, 227-231) */
const listeRemove = (item: ShoppingItem) => fake.client.from("shopping_items").delete().eq("id", item.id);
/** liste/page.tsx 151-160 */
async function listeClearChecked(items: ShoppingItem[]) {
  const ids = items.filter((i) => i.checked).map((i) => i.id);
  if (!ids.length) return { data: null, error: null };
  return fake.client.from("shopping_items").delete().in("id", ids);
}

// ====================================================================================== 5. invariants
type Violation = { type: string; seed: number; step: number; log: string[]; detail: string };
const violations: Violation[] = [];
const observations = new Map<string, { n: number; seed: number; step: number; log: string[]; detail: string }>();
const opCounts = new Map<string, number>();
const tally = new Map<string, number>();
const count = (k: string) => tally.set(k, (tally.get(k) ?? 0) + 1);

const rowsOfPlan = (table: "week_plan_recipes" | "shopping_items", planId: string | null) =>
  planId ? fake.tables[table].filter((r) => r.plan_id === planId).map((r) => ({ ...r })) : [];
const planOf = (week: string) => fake.tables.week_plans.find((p) => p.household_id === HH && p.week_start === week) as WeekPlan | undefined;
const itemsOfWeek = (week: string) => (rowsOfPlan("week_plan_recipes", planOf(week)?.id ?? null) as unknown as WeekPlanRecipe[]).sort((a, b) => a.position - b.position);
const snapWeek = (week: string) => JSON.stringify({ plan: planOf(week) ?? null, items: itemsOfWeek(week) });
const snapList = (week: string) => JSON.stringify(rowsOfPlan("shopping_items", planOf(week)?.id ?? null));
const flagKey = (i: WeekPlanRecipe) => `${!!i.postponed}/${!!i.already_bought}`;
const lineKey = (r: { ingredient_id: string | null; label: string }) => r.ingredient_id ?? `label:${r.label}`;
const strip = (r: Record<string, unknown>) => JSON.stringify({ ...r, id: undefined });
/** The banner compares label + quantity (weekPlan.ts listStatus): same key here, from the oracle's side. */
const contentKeys = (rows: { label: string; quantity_text: string | null }[]) => rows.map((r) => `${r.label}|${r.quantity_text ?? ""}`).sort();
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

const SHORT_COST = 100;
const RULE_BREAK_COST = 1000;
const portionCost = (extra: number) => (extra >= 0 ? extra : -extra * SHORT_COST);
const eligibleStrict = (c: PlannerRecipe, rules: Rules) =>
  c.active !== false && !NOT_A_MEAL.has(c.dishType ?? "") && (c.weeksSinceEaten === null || c.weeksSinceEaten >= rules.cooldownWeeks);
/** Adding c to `picked` keeps its own dish type and protein within the maxima. */
const fitsWith = (c: PlannerRecipe, picked: PlannerRecipe[], rules: Rules) =>
  (!c.dishType || picked.filter((x) => x.dishType === c.dishType).length < rules.maxSameDishType) &&
  (!c.protein || picked.filter((x) => x.protein === c.protein).length < rules.maxSameProtein);
/** Cost of a week as PROJET.md "Semaine" orders them: extra (a missing portion far worse), 2 per multiple the planner chose, variety first. */
function weekCost(ctx: Ctx, planner: PlannerRecipe[], plan: Planned[], target: number, fixed: ReadonlyMap<string, number>) {
  const sv = svOf(ctx);
  const total = plan.reduce((a, x) => a + x.multiplier * sv(x.id), 0);
  const multiples = plan.reduce((a, x) => a + (fixed.has(x.id) ? 0 : x.multiplier - 1), 0) * 2;
  return portionCost(total - target) + multiples + (respectsRules(plan, planner, ctx.rules) ? 0 : RULE_BREAK_COST);
}
/** The least cost of a week made of `ids` (fixed multipliers kept, the others optimal, independent DP). */
function bestCostOfIds(ctx: Ctx, planner: PlannerRecipe[], ids: string[], target: number, fixed: ReadonlyMap<string, number>) {
  const sv = svOf(ctx);
  const free = ids.filter((id) => !fixed.has(id));
  const fixedPortions = ids.reduce((a, id) => a + (fixed.get(id) ?? 0) * sv(id), 0);
  const portions = free.length ? optimalCost(free.map(sv), target - fixedPortions) : portionCost(fixedPortions - target);
  return portions + (respectsRules(ids.map((id) => ({ id, multiplier: 1 })), planner, ctx.rules) ? 0 : RULE_BREAK_COST);
}

// ====================================================================================== 4. driver
type Rng = () => number;
type Sess = {
  seed: number; ctx: Ctx; page: Page; log: string[]; rng: Rng; verbose: boolean;
  /** Migrations applied (0, 15 or 16); rpc = the saves are single transactions (>= 15). */
  level: 0 | 15 | 16; rpc: boolean;
  /** Content keys of the generated lines at the last successful "Faire la liste", by plan. */
  made: Map<string, string[]>;
  /** Plans whose generated lines were (partly) removed with « Retirer les articles cochés ». */
  cleared: Set<string>;
  /** A step-by-step save was cut half-way: the session stops there (partial state, expected without 0015). */
  done: boolean;
  /** A failed save left the page's settings different from the saved ones (page.tsx 221 / 250 set them first; resync 198-208 restores them when the week has a plan). */
  settingsDiverged: boolean;
};
const FAULT_P = 0.15;
/** App defects reproduced deterministically below (it.fails): reported, not counted in the zero-violation assertion. */
const KNOWN_DEFECTS = new Set<string>();
const pathName = (level: number) => (level === 0 ? "none" : level === 15 ? "0015" : "0016");

async function runSession(seed: number, verbose = false) {
  const rng = mulberry32(seed);
  Math.random = mulberry32(seed ^ 0x5bd1e995); // planner randomness, reproducible per seed
  const int = (a: number, b: number) => a + Math.floor(rng() * (b - a + 1));
  const pick = <T,>(a: T[]): T => a[Math.floor(rng() * a.length)];
  const chance = (x: number) => rng() < x;
  const level = pick([0, 15, 16] as const);
  const rpc = level >= 15;
  fake.reset(level);
  count(`sessions:${pathName(level)}`);
  setLang(chance(0.15) ? "en" : "fr");

  // Household rules, ratings (per session) and "today" anywhere in 2024-2029.
  const rules: Rules = { maxSameDishType: int(1, 4), maxSameProtein: int(1, 4), cooldownWeeks: int(0, 6) };
  const recipes = BASE_RECIPES.map((r) => ({ ...r, rating: chance(0.5) ? int(1, 5) : null }));
  const kitchen: Kitchen = { recipes, ingredients: INGREDIENTS, catalog: CATALOG };
  const today = new Date(2024, 0, 1 + int(0, 6 * 365));
  const thisWeek = weekStart(today);
  const ctx: Ctx = { kitchen, rules, recipeById: new Map(recipes.map((r) => [r.id, r])), thisWeek };
  const sv = svOf(ctx);
  const meals = recipes.filter((r) => r.active && !NOT_A_MEAL.has(r.dish_type ?? ""));

  // Random history: past plans 1-12 weeks before W.
  const offsets = [...new Set(Array.from({ length: int(0, 8) }, () => int(1, 12)))];
  for (const k of offsets) {
    const week = addWeeks(thisWeek, -k);
    const { data: plan } = await fake.client.from("week_plans").insert({ household_id: HH, week_start: week, suppers: 5, portions: 20 }).select("*").single();
    const ids = [...new Set(Array.from({ length: int(1, 6) }, () => pick(meals).id))];
    if (ids.length) await fake.client.from("week_plan_recipes").insert(ids.map((id, position) => ({ plan_id: (plan as WeekPlan).id, recipe_id: id, position, multiplier: 1, portions: sv(id) })), { defaultToNull: false });
  }
  // Sometimes this week already holds recipes postponed from last week (real postponeRecipe, W-1 -> W).
  if (chance(0.3)) {
    const prevWeek = addWeeks(thisWeek, -1);
    let prev = await loadWeek(HH, prevWeek);
    if (!prev.items.length) {
      const ids = [...new Set(Array.from({ length: int(1, 4) }, () => pick(meals).id))];
      await saveWeek(HH, prevWeek, { portions: 20, recipes: Math.max(5, ids.length), seasons: [seasonOf(new Date(`${prevWeek}T12:00:00`))], excludeDishTypes: [] }, ids.map((id) => ({ id, multiplier: int(1, 3) })), sv);
      prev = await loadWeek(HH, prevWeek);
    }
    const fallback: WeekSettings = { portions: int(4, 40), recipes: int(1, 8), seasons: [seasonOf(new Date(`${thisWeek}T12:00:00`))], excludeDishTypes: [] };
    for (let k = int(1, 3); k > 0 && prev.items.length; k--) {
      const plan = prev.plan!;
      const settings: WeekSettings = { portions: plan.portions ?? 20, recipes: plan.suppers, seasons: plan.seasons ?? [], excludeDishTypes: plan.exclude_dish_types ?? [] };
      const from = { week: prevWeek, settings, planned: prev.items.map((i) => ({ id: i.recipe_id, multiplier: i.multiplier || 1 })), flags: flagsOf(prev.items) };
      const res = await postponeRecipe(HH, from, pick(prev.items).recipe_id, chance(0.5), fallback, sv);
      if (res !== "already") prev = res.from;
    }
  }

  const s: Sess = { seed, ctx, page: await loadPage(ctx, 0), log: [], rng, verbose, level, rpc, made: new Map(), cleared: new Set(), done: false, settingsDiverged: false };
  const nOps = int(10, 40);
  for (let step = 0; step < nOps && !s.done; step++) {
    await doOp(s, step, { int, pick, chance });
  }
}

type R = { int: (a: number, b: number) => number; pick: <T>(a: T[]) => T; chance: (x: number) => boolean };
type CheckPlanner = {
  kind: "suggestAll" | "changeSettings" | "swap" | "refit";
  keep: string[];
  count: number;
  target: number;
  f: Filters;
  prevIds: string[];
  /** Recipes whose multiplier the planner did not choose (postponed; for a swap, minus the swapped recipe). */
  fixed: Map<string, number>;
  /** Swap: cost of the worst first try (planner.ts 223-233: the first try is a rule-respecting candidate if one exists). */
  swapBound?: number;
};

async function doOp(s: Sess, step: number, r: R) {
  const { ctx } = s;
  const p = s.page;
  const W = ctx.thisWeek,
    W1 = nextWeekOf(W);
  const other = p.week === W ? W1 : W;
  const sv = svOf(ctx);
  p.error = null; // the message shown belongs to the previous action
  const fail = (type: string, detail: string) => {
    violations.push({ type, seed: s.seed, step, log: [...s.log], detail });
  };
  const observe = (type: string, detail: string) => {
    const o = observations.get(type);
    if (!o) observations.set(type, { n: 1, seed: s.seed, step, log: [...s.log], detail });
    else {
      o.n++;
      if (s.log.length < o.log.length) Object.assign(o, { seed: s.seed, step, log: [...s.log], detail });
    }
  };
  const before = {
    items: p.items.map((i) => ({ ...i })),
    planId: p.planId,
    settings: structuredClone(p.settings),
    week: snapWeek(p.week),
    other: snapWeek(other),
    listThis: snapList(p.week),
    listOther: snapList(other),
    planIds: new Map(fake.tables.week_plans.map((x) => [x.week_start as string, x.id as string])),
  };
  const current = currentOf(p);
  const fixedBefore = fixedOf(p.items);
  const postponedBefore = p.items.filter((i) => i.postponed);

  // Fault injection: the k-th request of this operation's save is lost (only around the page handler's call).
  const faultK = r.chance(FAULT_P) ? r.int(1, 8) : 0; // up to 8: a postpone without 0015 makes ~8 requests
  const faultDuring = faultK && r.chance(0.5) ? r.int(1, 4) : 0;
  const tablesBefore = faultK ? JSON.stringify(fake.tables) : "";
  let fired = null as string | null;
  const armed = async <T,>(fn: () => Promise<T>): Promise<T> => {
    if (faultK) fake.arm(faultK, faultDuring);
    try {
      return await fn();
    } finally {
      fired = fired ?? fake.disarm();
    }
  };

  // ---------------------------------------------------------------- choose an available operation
  type Op = [name: string, weight: number, run: () => Promise<void>];
  const ops: Op[] = [];
  let checkPlanner = null as CheckPlanner | null;
  let touchesOtherWeek = false;
  let touchesList = null as string | null;
  let flagChange = null as string | null; // recipe whose flags the op may change
  let mayChange = null as string | null; // the postponed recipe this op may drop or re-multiply
  let persisted = false;

  const available = availableOf(p);
  // Empty week: "Proposer" needs available (401); with recipes, "Proposer une autre semaine" (484).
  if (p.items.length || available) {
    ops.push(["suggestAll", 6, async () => {
      s.log.push(`suggestAll`);
      const res = await armed(() => suggestAll(ctx, p));
      if (fired) return;
      persisted = res.saved;
      checkPlanner = { kind: "suggestAll", keep: [], count: p.settings.recipes, target: p.settings.portions, f: filtersOf(p), prevIds: [], fixed: fixedBefore };
      if (!res.plan.length && available) fail("suggestAll-empty-with-available", `available=${available} but planWeek returned []`);
    }]);
  }
  const stepOp = (name: string, field: "portions" | "recipes", min: number, max: number) => {
    ops.push([name, 5, async () => {
      const v = p.settings[field];
      // Stepper 33-68: − enabled while value > min (39), + while value < max (62); a typed number is clamped on
      // blur and only applied when different (55-59). add() can push `recipes` past 10 (249): then only − works.
      const choices = [...(v > min ? [v - 1] : []), ...(v < max ? [v + 1] : [])];
      const nv = r.chance(0.25) || !choices.length ? Math.min(max, Math.max(min, r.int(min - 2, max + 2))) : r.pick(choices);
      if (nv === v) {
        s.log.push(`${name} typed same ${nv} (no-op)`);
        return;
      }
      s.log.push(`${name} ${v}->${nv}`);
      const next = { ...p.settings, [field]: nv };
      const res = await armed(() => changeSettings(ctx, p, next));
      if (fired) return;
      if (res.kind !== "none") persisted = res.saved;
      if (res.kind === "replan") {
        if (res.fallback) fail("changeSettings-fallback-refit", "planWeek returned [] with keep");
        checkPlanner = { kind: "changeSettings", keep: current.map((x) => x.id), count: next.recipes, target: next.portions, f: { seasons: next.seasons, excludeDishTypes: next.excludeDishTypes }, prevIds: current.map((x) => x.id), fixed: fixedBefore };
      }
    }]);
  };
  // page.tsx 342-343: portions 1-80; recipes from max(1, number of postponed recipes) to 10.
  stepOp("portions", "portions", 1, 80);
  stepOp("recipes", "recipes", Math.max(1, fixedBefore.size), 10);
  ops.push(["season", 3, async () => {
    const se = r.pick(ALL_SEASONS);
    s.log.push(`toggleSeason ${se}`);
    const res = await armed(() => changeSettings(ctx, p, { ...p.settings, seasons: toggleIn(p.settings.seasons, se) }));
    if (fired) return;
    if (res.kind !== "none") persisted = res.saved;
  }]);
  ops.push(["dishType", 3, async () => {
    const d = r.pick(dishTypesOf(ctx));
    s.log.push(`toggleDishType ${d}`);
    const res = await armed(() => changeSettings(ctx, p, { ...p.settings, excludeDishTypes: toggleIn(p.settings.excludeDishTypes, d) }));
    if (fired) return;
    if (res.kind !== "none") persisted = res.saved;
  }]);
  if (p.items.length) {
    ops.push(["swap", 6, async () => {
      const id = r.pick(current).id;
      s.log.push(`swap ${id}${fixedBefore.has(id) ? " (postponed)" : ""}`);
      mayChange = id;
      const avoid = [...p.swappedAway];
      const others = current.filter((x) => x.id !== id).map((x) => x.id);
      const othersR = others.map((x) => p.planner.find((y) => y.id === x)!);
      // Candidates of the first try (swapFor -> suggest, strict rules first): eligible, in the filters, fitting.
      const strict = p.planner.filter((c) => !current.some((x) => x.id === c.id) && !avoid.includes(c.id) && passesFilters(c, filtersOf(p)) && eligibleStrict(c, ctx.rules) && fitsWith(c, othersR, ctx.rules));
      const fixedS = new Map([...fixedBefore].filter(([k]) => k !== id));
      const res = await armed(() => swap(ctx, p, id));
      if (fired) return;
      if (!res) {
        if (strict.length) fail("swap-none-though-candidate", `${strict.length} candidates e.g. ${strict[0].id}`);
        return;
      }
      persisted = !p.error;
      const newId = res.find((x) => !others.includes(x.id))?.id;
      // Same week minus the swapped recipe plus one new one, same order.
      if (res.length !== current.length || res.some((x, i) => (current[i].id === id ? x.id === id : x.id !== current[i].id))) fail("swap-shape", `before ${current.map((x) => x.id)} after ${res.map((x) => x.id)}`);
      const nr = p.planner.find((x) => x.id === newId);
      if (!nr) fail("swap-shape", "no new recipe");
      else {
        if (avoid.includes(nr.id)) fail("swap-avoided-recipe-back", `${nr.id} was swapped away earlier`);
        if (!passesFilters(nr, filtersOf(p))) fail("strict-filter-violated:swap", `${nr.id} seasons=${nr.seasons} type=${nr.dishType} filters=${JSON.stringify(filtersOf(p))}`);
        if (nr.active === false || NOT_A_MEAL.has(nr.dishType ?? "")) fail("inactive-or-side-suggested:swap", nr.id);
      }
      // Variety first (PROJET.md "Échanger"): the first try is a strict candidate whenever one exists, so if a
      // candidate gives a rule-respecting week, the result respects the rules.
      const good = strict.filter((c) => respectsRules([...others, c.id].map((x) => ({ id: x, multiplier: 1 })), p.planner, ctx.rules));
      if (good.length && !respectsRules(res, p.planner, ctx.rules)) {
        fail("variety-broken-though-respecting-swap-existed", `swap ${id} -> ${newId}; respecting candidates e.g. ${good.slice(0, 3).map((c) => c.id)}; rules ${JSON.stringify(ctx.rules)}`);
      }
      const swapBound = strict.length ? Math.max(...strict.map((c) => bestCostOfIds(ctx, p.planner, current.map((x) => (x.id === id ? c.id : x.id)), p.settings.portions, fixedS))) : undefined;
      checkPlanner = { kind: "swap", keep: [], count: 99, target: p.settings.portions, f: filtersOf(p), prevIds: current.map((x) => x.id), fixed: fixedS, swapBound };
    }]);
    ops.push(["remove", 4, async () => {
      const id = r.pick(current).id;
      s.log.push(`remove ${id}${fixedBefore.has(id) ? " (postponed)" : ""}`);
      mayChange = id;
      persisted = await armed(() => remove(ctx, p, id));
      if (fired) return;
      if (p.items.some((i) => i.recipe_id === id)) fail("remove-kept", id);
      if (p.items.length) checkPlanner = { kind: "refit", keep: [], count: 99, target: p.settings.portions, f: filtersOf(p), prevIds: current.map((x) => x.id), fixed: new Map([...fixedBefore].filter(([k]) => k !== id)) };
    }]);
    // Card buttons 444-450: − disabled at 1, + disabled at 6.
    const ups = p.items.filter((i) => (i.multiplier || 1) < 6);
    if (ups.length) {
      ops.push(["multUp", 3, async () => {
        const it = r.pick(ups);
        s.log.push(`multiplier+ ${it.recipe_id} (${it.multiplier})`);
        mayChange = it.recipe_id;
        persisted = await armed(() => setMultiplier(ctx, p, it.recipe_id, (it.multiplier || 1) + 1));
        if (fired) return;
        const now = p.items.find((i) => i.recipe_id === it.recipe_id);
        if (now?.multiplier !== it.multiplier + 1) fail("multiplier-not-applied", `${it.multiplier}+1 -> ${now?.multiplier}`);
        for (const i of p.items) if (i.recipe_id !== it.recipe_id && i.multiplier !== before.items.find((b) => b.recipe_id === i.recipe_id)?.multiplier) fail("multiplier-other-changed", i.recipe_id);
      }]);
    }
    const downs = p.items.filter((i) => (i.multiplier || 1) > 1);
    if (downs.length) {
      ops.push(["multDown", 3, async () => {
        const it = r.pick(downs);
        s.log.push(`multiplier- ${it.recipe_id} (${it.multiplier})`);
        mayChange = it.recipe_id;
        persisted = await armed(() => setMultiplier(ctx, p, it.recipe_id, (it.multiplier || 1) - 1));
        if (fired) return;
        const now = p.items.find((i) => i.recipe_id === it.recipe_id);
        if (now?.multiplier !== it.multiplier - 1) fail("multiplier-not-applied", `${it.multiplier}-1 -> ${now?.multiplier}`);
      }]);
    }
    if (p.offset === 0) {
      // ⏭ only on this week (457-461), then the yes / no dialog (495-507).
      for (const bought of [true, false]) {
        ops.push([bought ? "postponeYes" : "postponeNo", 4, async () => {
          const it = r.pick(p.items);
          s.log.push(`postpone ${it.recipe_id} x${it.multiplier} bought=${bought}`);
          mayChange = it.recipe_id;
          const nextBefore = await loadWeek(HH, W1);
          const nextPlanBefore = planOf(W1) ? { ...planOf(W1)! } : null;
          const settingsW = structuredClone(p.settings);
          touchesOtherWeek = true;
          const res = await armed(() => postpone(ctx, p, it.recipe_id, bought));
          if (fired) return;
          const nextAfter = await loadWeek(HH, W1);
          if (res === "error") return fail("postpone-error", p.error ?? "");
          if (res === "already") {
            if (!nextBefore.items.some((i) => i.recipe_id === it.recipe_id)) fail("postpone-already-wrongly", it.recipe_id);
            if (snapWeek(W) !== before.week) fail("postpone-already-changed-W", "");
            if (snapWeek(W1) !== before.other) fail("postpone-already-changed-W1", "");
            if (JSON.stringify(p.items) !== JSON.stringify(before.items)) fail("postpone-already-changed-page", "");
            return;
          }
          persisted = !p.error;
          if (nextBefore.items.some((i) => i.recipe_id === it.recipe_id)) fail("postpone-duplicated", it.recipe_id);
          // W: the recipe is gone, the others untouched (same order, multipliers and flags; nothing refit).
          const restBefore = before.items.filter((i) => i.recipe_id !== it.recipe_id);
          const sig = (xs: WeekPlanRecipe[]) => JSON.stringify(xs.map((i) => [i.recipe_id, i.multiplier, i.portions, flagKey(i)]));
          if (sig(p.items) !== sig(restBefore)) fail("postpone-changed-other-recipes-of-W", `${sig(restBefore)} -> ${sig(p.items)}`);
          // W+1: previous items untouched, the moved recipe appended with its multiplier and flags.
          const prev = nextAfter.items.slice(0, -1),
            last = nextAfter.items[nextAfter.items.length - 1];
          if (sig(prev) !== sig(nextBefore.items)) fail("postpone-changed-W1-recipes", `${sig(nextBefore.items)} -> ${sig(prev)}`);
          if (!last || last.recipe_id !== it.recipe_id || last.multiplier !== it.multiplier || !last.postponed || last.already_bought !== bought || last.portions !== it.multiplier * sv(it.recipe_id)) {
            fail("postpone-moved-row-wrong", JSON.stringify(last));
          }
          if (itemsOfWeek(W).some((i) => i.recipe_id === it.recipe_id)) fail("postpone-recipe-in-both-weeks", it.recipe_id);
          const plan = nextAfter.plan!;
          const base = nextPlanBefore
            ? { portions: nextPlanBefore.portions, suppers: nextPlanBefore.suppers, seasons: nextPlanBefore.seasons, ex: nextPlanBefore.exclude_dish_types }
            : { portions: settingsW.portions, suppers: settingsW.recipes, seasons: [seasonOf(new Date(`${W1}T12:00:00`))], ex: settingsW.excludeDishTypes };
          if (plan.portions !== base.portions || plan.suppers !== Math.max(base.suppers, nextAfter.items.length) || JSON.stringify(plan.seasons) !== JSON.stringify(base.seasons) || JSON.stringify(plan.exclude_dish_types) !== JSON.stringify(base.ex)) {
            fail("postpone-W1-settings", `${JSON.stringify(base)} -> ${JSON.stringify(plan)}`);
          }
          if (nextPlanBefore && nextPlanBefore.id !== plan.id) fail("plan-id-changed", W1);
          if (snapList(W1) !== before.listOther) fail("lists-not-independent", "postpone changed W+1's list");
        }]);
      }
    }
    const pp = p.items.filter((i) => i.postponed);
    if (pp.length) {
      // 431-438: on a postponed card.
      ops.push(["setBought", 6, async () => {
        const it = r.pick(pp);
        s.log.push(`setBought ${it.recipe_id} ${!it.already_bought}`);
        flagChange = it.recipe_id;
        persisted = await armed(() => setBought(ctx, p, it.recipe_id, !it.already_bought));
        if (fired) return;
        const now = p.items.find((i) => i.recipe_id === it.recipe_id);
        if (!now || now.already_bought !== !it.already_bought || !now.postponed) fail("setBought-wrong", JSON.stringify(now));
        if (JSON.stringify(currentOf(p)) !== JSON.stringify(current)) fail("setBought-changed-plan", "");
      }]);
    }
    if (p.planId) {
      ops.push(["makeList", 6, async () => {
        s.log.push(`makeList ${p.week}`);
        touchesList = p.week;
        const prevRows = rowsOfPlan("shopping_items", p.planId);
        const ok = await armed(() => makeList(ctx, p));
        if (fired) return;
        if (!ok) return; // reported as db-error below
        s.made.set(p.planId!, contentKeys(listRows(p.items, ctx.kitchen.recipes, ctx.kitchen.ingredients, ctx.kitchen.catalog)));
        s.cleared.delete(p.planId!);
        checkList(prevRows);
        // Right after "Faire la liste" the banner is off (or "none" when the list has no generated line).
        const st = await listStatusOf(ctx, p.planId!, p.items);
        const hasGen = rowsOfPlan("shopping_items", p.planId).some((x) => !x.manual);
        if (st !== (hasGen || s.level >= 16 ? "current" : "none")) fail("listStatus-after-makeList", `${st} (generated lines: ${hasGen})`);
        // Idempotence: a second "Faire la liste" gives the same rows (ids aside).
        const once = rowsOfPlan("shopping_items", p.planId).map(strip).sort();
        await makeList(ctx, p);
        const twice = rowsOfPlan("shopping_items", p.planId).map(strip).sort();
        if (JSON.stringify(once) !== JSON.stringify(twice)) fail("makeList-not-idempotent", "");
        // "Faire la liste" opens /liste?plan=<id>: that plan's list is shown (non-empty) first.
        const view = await listeLoad(W, p.planId, null);
        if (rowsOfPlan("shopping_items", p.planId).length && view.planId !== p.planId) fail("liste-requested-not-first", `${view.planId} != ${p.planId}`);
      }]);
    }
  }
  // Picker (404 / 469), 513-527: any pickable recipe, even outside the filters.
  const pk = pickable(ctx, p);
  if (pk.length) {
    ops.push(["add", 5, async () => {
      const rec = r.pick(pk);
      s.log.push(`add ${rec.id}`);
      persisted = await armed(() => add(ctx, p, rec.id));
      if (fired) return;
      if (!p.items.some((i) => i.recipe_id === rec.id)) fail("add-missing", rec.id);
      if (p.items.length > 1) checkPlanner = { kind: "refit", keep: [], count: 99, target: p.settings.portions, f: filtersOf(p), prevIds: current.map((x) => x.id), fixed: fixedBefore };
      if (p.settings.recipes < p.items.length) fail("add-recipes-setting", "");
    }]);
  }
  ops.push(["switchWeek", 4, async () => {
    const to = (p.offset === 0 ? 1 : 0) as 0 | 1;
    s.log.push(`switchWeek -> ${to === 0 ? "this" : "next"}`);
    s.page = await loadPage(ctx, to);
  }]);

  // ---------------------------------------------------------------- liste page operations
  const wanted = r.pick([W, W1, null]);
  const view = await listeLoad(W, null, wanted);
  const listOps: Op[] = [];
  listOps.push(["listOpen", 2, async () => {
    s.log.push(`listOpen wanted=${wanted}`);
    const req = r.chance(0.5) ? r.pick(fake.tables.week_plans.map((x) => x.id as string)) ?? null : null;
    const v = await listeLoad(W, req, null);
    // Independent order: the requested plan, this week, upcoming (soonest first), then past (latest first).
    const plans = [...fake.tables.week_plans].sort((a, b) => ((a.week_start as string) < (b.week_start as string) ? 1 : -1)).slice(0, 6) as unknown as WeekPlan[];
    const exp = [
      ...plans.filter((x) => x.id === req),
      ...plans.filter((x) => x.id !== req && x.week_start === W),
      ...plans.filter((x) => x.id !== req && x.week_start > W).sort((a, b) => a.week_start.localeCompare(b.week_start)),
      ...plans.filter((x) => x.id !== req && x.week_start < W).sort((a, b) => b.week_start.localeCompare(a.week_start)),
    ];
    if (JSON.stringify(exp.map((x) => x.id)) !== JSON.stringify(v.ordered.map((x) => x.id))) fail("listOrder", `${exp.map((x) => x.week_start)} vs ${v.ordered.map((x) => x.week_start)}`);
    const firstNonEmpty = exp.find((x) => fake.tables.shopping_items.some((i) => i.plan_id === x.id));
    if ((firstNonEmpty?.id ?? exp[0]?.id ?? null) !== v.planId) fail("liste-shown-plan", `${firstNonEmpty?.week_start} vs ${v.planWeek}`);
  }]);
  if (!view.empty && view.planId) {
    const planWeekOfView = view.planWeek!;
    if (view.items.length) {
      listOps.push(["listToggle", 4, async () => {
        // Manual items favoured: a ticked manual item must never tick a generated line.
        const manualItems = view.items.filter((i) => i.manual);
        const it = manualItems.length && r.chance(0.35) ? r.pick(manualItems) : r.pick(view.items);
        s.log.push(`listToggle ${planWeekOfView} ${it.manual ? "manual " : ""}${it.label} -> ${!it.checked}`);
        touchesList = planWeekOfView;
        const before2 = rowsOfPlan("shopping_items", view.planId);
        const { error } = await listeToggle(it);
        if (error) return fail("db-error", JSON.stringify(error));
        const after2 = rowsOfPlan("shopping_items", view.planId);
        for (const a of after2) {
          const b = before2.find((x) => x.id === a.id)!;
          const exp = a.id === it.id ? { ...b, checked: !it.checked } : b;
          if (JSON.stringify(a) !== JSON.stringify(exp)) fail("listToggle-wrong", a.label as string);
        }
      }]);
    }
    listOps.push(["listAdd", 5, async () => {
      // Labels of generated uncatalogued lines too ("Truc maison", "Garniture maison (facultatif)"): same tick key.
      const label = r.pick(["Papier de toilette", "Café", "  Lait  ", "Truc maison", "Bananes", "Savon", "Garniture maison (facultatif)", "Garniture maison (optional)"]);
      s.log.push(`listAdd ${planWeekOfView} "${label}"`);
      touchesList = planWeekOfView;
      const { data, error } = await listeAdd(view.planId!, label);
      if (error) return fail("db-error", JSON.stringify(error));
      const d = data as ShoppingItem;
      if (!d.manual || d.checked || d.ingredient_id !== null || d.pantry || d.label !== label.trim() || d.plan_id !== view.planId) fail("listAdd-row", JSON.stringify(d));
    }]);
    const manual = view.items.filter((i) => i.manual);
    if (manual.length) {
      listOps.push(["listRemove", 10, async () => {
        const it = r.pick(manual);
        s.log.push(`listRemove ${planWeekOfView} ${it.label}`);
        touchesList = planWeekOfView;
        await listeRemove(it);
        if (fake.tables.shopping_items.some((x) => x.id === it.id)) fail("listRemove-kept", it.label);
      }]);
    }
    if (view.items.some((i) => i.checked)) {
      listOps.push(["listClear", 10, async () => {
        s.log.push(`listClearChecked ${planWeekOfView}`);
        touchesList = planWeekOfView;
        const n0 = rowsOfPlan("shopping_items", view.planId).length;
        await listeClearChecked(view.items);
        if (view.items.some((i) => i.checked && !i.manual)) s.cleared.add(view.planId!);
        const left = rowsOfPlan("shopping_items", view.planId);
        if (left.some((x) => x.checked) || left.length !== n0 - view.items.filter((i) => i.checked).length) fail("listClear-wrong", "");
      }]);
    }
  }
  const all = [...ops, ...listOps];
  const total = all.reduce((a, o) => a + o[1], 0);
  let x = s.rng() * total;
  const op = all.find((o) => (x -= o[1]) < 0) ?? all[all.length - 1];
  opCounts.set(op[0], (opCounts.get(op[0]) ?? 0) + 1);
  count(`op:${op[0]}:${pathName(s.level)}`);
  const isList = op[0].startsWith("list");

  // ---------------------------------------------------------------- list check (makeList)
  function checkList(prevRows: Record<string, unknown>[]) {
    const rows = rowsOfPlan("shopping_items", p.planId);
    const gen = rows.filter((x) => !x.manual).sort((a, b) => (a.position as number) - (b.position as number)) as unknown as ShoppingItem[];
    // Same function as the app, from the week's items minus already bought.
    const notBought = p.items.filter((i) => !i.already_bought);
    const cat = new Map<string, CatalogItem>(CATALOG.map((c) => [c.id, c]));
    const exp = buildShoppingList(
      notBought.map((i) => ({ title: ctx.recipeById.get(i.recipe_id)!.title, factor: i.multiplier || 1, ingredients: ING_BY_RECIPE.get(i.recipe_id) ?? [] })),
      cat,
    ).filter((l) => l.aisle !== NO_AISLE);
    const expRows = exp.map((l) => [l.ingredientId, l.optional ? `${l.label} ${tr("(facultatif)", "(optional)")}` : l.label, l.quantityText, l.aisle, l.pantry]);
    if (JSON.stringify(gen.map((g) => [g.ingredient_id, g.label, g.quantity_text, g.aisle, g.pantry])) !== JSON.stringify(expRows)) fail("list-differs-from-buildShoppingList", `${gen.length} rows vs ${exp.length}`);
    // Structural, independent of shopping.ts: every non-bought recipe's (non-water) article is present (the
    // lemon / lime may become its juice article), and no article comes only from already-bought recipes.
    const keys = new Set(gen.map((g) => g.ingredient_id ?? `nom:${g.label}`));
    const allowed = new Set<string>();
    for (const it of notBought) {
      for (const ing of ING_BY_RECIPE.get(it.recipe_id) ?? []) {
        const c = ing.ingredient_id ? CAT_BY_ID.get(ing.ingredient_id) : undefined;
        if (c?.aisle === NO_AISLE) continue;
        const opts = c ? [c.id, ...(JUICE_OF[c.name] ? [JUICE_OF[c.name]] : [])] : [`nom:${ing.name}`, `nom:${ing.name} ${tr("(facultatif)", "(optional)")}`];
        opts.forEach((o) => allowed.add(o));
        if (!opts.some((o) => keys.has(o))) fail("list-missing-article", `${it.recipe_id}: ${ing.ingredient_id ?? ing.name}`);
      }
    }
    for (const k of keys) {
      if (!allowed.has(k)) {
        const fromBought = p.items.some((i) => i.already_bought && (ING_BY_RECIPE.get(i.recipe_id) ?? []).some((g) => g.ingredient_id === k));
        fail(fromBought ? "list-has-article-only-from-bought-recipe" : "list-has-unknown-article", k);
      }
    }
    if (gen.some((g) => /^(Eau|Water)$/.test(g.label))) fail("list-has-water", "");
    // Manual rows untouched.
    const manBefore = prevRows.filter((x) => x.manual).map((x) => JSON.stringify(x)).sort();
    const manAfter = rows.filter((x) => x.manual).map((x) => JSON.stringify(x)).sort();
    if (JSON.stringify(manBefore) !== JSON.stringify(manAfter)) fail("manual-items-lost", `${manBefore.length} -> ${manAfter.length}`);
    // Ticked generated lines that still exist stay ticked; others are unticked. A ticked MANUAL item never ticks
    // a generated line (weekPlan.ts generateList, 0015 replace_list).
    const tickedGen = new Set(prevRows.filter((x) => x.checked && !x.manual).map((x) => lineKey(x as unknown as ShoppingItem)));
    const tickedManual = new Set(prevRows.filter((x) => x.checked && x.manual).map((x) => lineKey(x as unknown as ShoppingItem)));
    for (const g of gen) {
      if (g.checked && !tickedGen.has(lineKey(g))) fail(tickedManual.has(lineKey(g)) ? "manual-tick-ticks-generated-line" : "list-new-line-ticked", g.label);
      if (!g.checked && tickedGen.has(lineKey(g))) fail("list-ticked-line-unticked", g.label);
      if (!g.checked && tickedManual.has(lineKey(g))) count("manual-tick-not-propagated (checked)");
    }
    // Observation: lines removed with "Retirer les articles cochés" come back unticked on the next list.
    const prevGenKeys = new Set(prevRows.filter((x) => !x.manual).map((x) => lineKey(x as unknown as ShoppingItem)));
    if (prevRows.length && gen.some((g) => !prevGenKeys.has(lineKey(g)) && s.log.some((l) => l.startsWith(`listClearChecked ${p.week}`)))) {
      observe("cleared-checked-lines-come-back", "after « Retirer les articles cochés », regenerating the list re-adds those lines, unticked");
    }
  }

  // ---------------------------------------------------------------- run
  try {
    await op[2]();
  } catch (e) {
    fail("exception", `${op[0]}: ${(e as Error)?.stack ?? JSON.stringify(e)}`);
  }
  if (s.verbose) console.log(`#${step} ${s.log[s.log.length - 1]}${fired ? ` [FAULT at ${fired}]` : ""}  -> ${s.page.items.map((i) => `${i.recipe_id}x${i.multiplier}${i.postponed ? "P" : ""}${i.already_bought ? "B" : ""}`).join(", ")} | ${JSON.stringify(s.page.settings)} ${s.page.error ?? ""}`);
  const q = s.page;

  // ---------------------------------------------------------------- lost connection
  if (fired) {
    const path = pathName(s.level);
    const firedAt: string = fired;
    count(`fault:${path}:${op[0]}`);
    count(`fault:${path}:at ${firedAt}${s.rpc && faultDuring && firedAt.startsWith("rpc") ? " (inside the transaction)" : ""}`);
    if (!q.error) fail("fault-without-error", `${op[0]}: request ${firedAt} failed but the page shows no error`);
    const unchanged = JSON.stringify(fake.tables) === tablesBefore;
    // After the failure the page shows the week as saved (resync, page.tsx 198-208).
    const pageUnchanged = JSON.stringify(q.items) === JSON.stringify(before.items) && q.planId === before.planId;
    if (unchanged && !pageUnchanged) fail("page-changed-after-failed-save", op[0]);
    if (JSON.stringify(q.items) !== JSON.stringify(itemsOfWeek(q.week)) || q.planId !== (planOf(q.week)?.id ?? null)) fail("page-not-resynced-after-failed-save", op[0]);
    if (planOf(q.week) && JSON.stringify(q.settings) !== JSON.stringify(settingsOf(planOf(q.week)!, q.week))) fail("settings-not-resynced-after-failed-save", op[0]);
    if (JSON.stringify(q.settings) !== JSON.stringify(before.settings)) {
      s.settingsDiverged = true;
      count(`settings-kept-after-failed-save:${op[0]}`);
    }
    if (s.rpc) {
      // Migration applied: every save is one request; a failure changes nothing at all.
      if (!unchanged) fail(`rpc-not-atomic:${op[0]}`, `failed at ${firedAt}, the database changed`);
      else count(`atomic-ok:${op[0]}`);
    } else if (!unchanged) {
      // Step by step: expected partial states, classified; the session stops (nothing sensible to check after).
      const kinds: string[] = [];
      if (op[0].startsWith("postpone")) {
        const id = s.log[s.log.length - 1].split(" ")[1];
        const inW = itemsOfWeek(W).some((i) => i.recipe_id === id),
          inW1 = itemsOfWeek(W1).some((i) => i.recipe_id === id);
        if (inW && inW1) kinds.push("recipe-in-both-weeks");
        if (!inW && !inW1) kinds.push("recipe-in-neither-week");
      }
      for (const w of [W, W1]) {
        const b = JSON.parse(w === p.week ? before.week : before.other) as { plan: WeekPlan | null; items: WeekPlanRecipe[] };
        const a = JSON.parse(snapWeek(w)) as { plan: WeekPlan | null; items: WeekPlanRecipe[] };
        if (b.items.length && !a.items.length) kinds.push("week-emptied");
        else if (JSON.stringify(b.plan) !== JSON.stringify(a.plan) && JSON.stringify(b.items) === JSON.stringify(a.items)) kinds.push("settings-saved-recipes-not");
        const genB = JSON.parse(w === p.week ? before.listThis : before.listOther).filter((x: ShoppingItem) => !x.manual).length;
        const genA = rowsOfPlan("shopping_items", planOf(w)?.id ?? null).filter((x) => !x.manual).length;
        if (genB && !genA) kinds.push("list-generated-lines-lost");
      }
      const kind = kinds.length ? [...new Set(kinds)].join("+") : "other";
      count(`fallback-partial:${op[0]}:${kind}`);
      observe(`fallback-partial-state:${kind}`, `${op[0]} cut at ${firedAt} without migration 0015`);
      s.done = true;
      return;
    } else count(`fallback-fault-nothing-written:${op[0]}`);
  } else if (q.error && !/^Aucune|^Cette recette/.test(q.error)) fail("db-error", q.error);

  // ---------------------------------------------------------------- generic invariants
  // Database shape.
  const plans = fake.tables.week_plans.filter((x) => x.household_id === HH);
  if (new Set(plans.map((x) => x.week_start)).size !== plans.length) fail("duplicate-plan-for-week", "");
  for (const [w, id] of before.planIds) if (planOf(w) && planOf(w)!.id !== id) fail("plan-id-changed", w);
  for (const week of [W, W1]) {
    const plan = planOf(week);
    if (!plan) continue;
    const rows = itemsOfWeek(week);
    const ids = rows.map((x) => x.recipe_id);
    if (new Set(ids).size !== ids.length) fail("duplicate-recipe-in-week", `${week}: ${ids}`);
    const pos = rows.map((x) => x.position).sort((a, b) => a - b);
    if (pos.some((v, i) => v !== i)) fail("positions-not-contiguous", `${week}: ${pos}`);
    for (const x of rows) {
      if (!Number.isInteger(x.multiplier) || x.multiplier < 1) fail("multiplier-not-positive-integer", `${week} ${x.recipe_id} ${x.multiplier}`);
      if (x.portions !== x.multiplier * sv(x.recipe_id)) fail("portions-column-wrong", `${week} ${x.recipe_id} ${x.portions} != ${x.multiplier}*${sv(x.recipe_id)}`);
      if (typeof x.postponed !== "boolean" || typeof x.already_bought !== "boolean") fail("flag-not-boolean", JSON.stringify(x));
      if (x.already_bought && !x.postponed) fail("already-bought-without-postponed", `${week} ${x.recipe_id}`);
      if (!ctx.recipeById.get(x.recipe_id)) fail("unknown-recipe", x.recipe_id);
    }
    if (rows.length > plan.suppers) fail(`more-recipes-than-maximum${s.settingsDiverged ? "-after-failed-save" : ""}`, `${week}: ${rows.length} > ${plan.suppers}`);
    if (fixedOf(rows).size > plan.suppers) fail("fewer-max-recipes-than-postponed", `${week}`);
  }
  // The page shows what is saved.
  if (!isList && op[0] !== "switchWeek") {
    const saved = await loadWeek(HH, q.week);
    if (JSON.stringify(saved.items) !== JSON.stringify(q.items)) fail("page-differs-from-db", op[0]);
    if (persisted && !fired) {
      const sp = saved.plan!;
      if (sp.portions !== q.settings.portions || sp.suppers !== q.settings.recipes || JSON.stringify(sp.seasons) !== JSON.stringify(q.settings.seasons) || JSON.stringify(sp.exclude_dish_types) !== JSON.stringify(q.settings.excludeDishTypes)) fail("settings-not-saved", op[0]);
    }
  }
  if (op[0] !== "switchWeek" && !isList) {
    // Flags preserved across every save (except the op that is about them).
    for (const b of before.items) {
      const a = q.items.find((i) => i.recipe_id === b.recipe_id);
      if (a && b.recipe_id !== flagChange && flagKey(a) !== flagKey(b)) fail("flags-lost", `${op[0]} ${b.recipe_id} ${flagKey(b)} -> ${flagKey(a)}`);
    }
    // PROJET.md "Semaine": a postponed recipe is fixed. Kept with its multiplier by everything but ✕ on it,
    // « Échanger » on it, its own − / + and moving it (postpone).
    for (const b of postponedBefore) {
      if (b.recipe_id === mayChange) continue;
      const a = q.items.find((i) => i.recipe_id === b.recipe_id);
      if (!a) fail(`postponed-dropped-by-${op[0]}`, `${b.recipe_id} (x${b.multiplier}, bought=${b.already_bought}); week now ${q.items.map((i) => i.recipe_id)}; settings ${JSON.stringify(q.settings)}`);
      else if (a.multiplier !== b.multiplier) fail(`postponed-multiplier-changed-by-${op[0]}`, `${b.recipe_id} x${b.multiplier} -> x${a.multiplier}`);
      else if (!a.postponed) fail(`postponed-flag-lost-by-${op[0]}`, b.recipe_id);
      else count(`fixed-kept:${op[0]}`);
    }
  }
  // Other week untouched (postpone writes W+1's recipes only), other list untouched by everything.
  if (op[0] !== "switchWeek") {
    if (!touchesOtherWeek && snapWeek(other) !== before.other) fail("weeks-not-independent", op[0]);
    if (touchesList !== other && snapList(other) !== before.listOther && !isList) fail("lists-not-independent", op[0]);
    if (!isList && touchesList !== q.week && snapList(q.week) !== before.listThis) fail("list-changed-without-makeList", op[0]);
    if (isList && touchesList) {
      const otherList = touchesList === W ? W1 : W;
      if (snapList(otherList) !== (otherList === q.week ? before.listThis : before.listOther)) fail("lists-not-independent", `${op[0]} on ${touchesList}`);
    }
  }
  // The "list out of date" banner (page.tsx 166-176, 475-482): "none" before any list, "current" while the
  // generated lines match the recipes as at the last "Faire la liste", "stale" after a change of listRows.
  for (const week of [W, W1]) {
    const plan = planOf(week);
    if (!plan) continue;
    const items = itemsOfWeek(week);
    const got = await listStatusOf(ctx, plan.id, items);
    const genStored = rowsOfPlan("shopping_items", plan.id).filter((x) => !x.manual).length;
    const made = s.made.get(plan.id);
    let exp: "none" | "current" | "stale";
    if (made && s.level >= 16) {
      // 0016: the fingerprint taken at "Faire la liste" decides, whatever was removed from the list since.
      exp = sameList(made, contentKeys(listRows(items, ctx.kitchen.recipes, ctx.kitchen.ingredients, ctx.kitchen.catalog))) ? "current" : "stale";
      if (s.cleared.has(plan.id)) count(`listStatus:0016-after-clear:${exp}`);
    } else if (!made) {
      if (genStored) fail("generated-lines-without-makeList", week);
      exp = "none";
    } else if (!genStored) exp = "none";
    else if (s.cleared.has(plan.id)) {
      // Generated lines removed with « Retirer les articles cochés »: the stored list no longer equals any recipes' list.
      const same = sameList(made, contentKeys(listRows(items, ctx.kitchen.recipes, ctx.kitchen.ingredients, ctx.kitchen.catalog)));
      if (same && got === "stale") observe("banner-stale-after-clearing-ticked-lines (without 0016)", `${week}: recipes unchanged since "Faire la liste", ticked generated lines cleared on the list → Semaine says the list is out of date`);
      count(`listStatus:after-clear:${got}`);
      continue;
    } else exp = sameList(made, contentKeys(listRows(items, ctx.kitchen.recipes, ctx.kitchen.ingredients, ctx.kitchen.catalog))) ? "current" : "stale";
    count(`listStatus:${exp}`);
    if (got !== exp) fail(`listStatus-${got}-expected-${exp}`, `${week} after ${op[0]}`);
  }
  // Planner results.
  const cp = checkPlanner;
  if (cp && q.items.length && !q.error) {
    const plan = currentOf(q);
    const fixed = cp.fixed;
    const total = plan.reduce((a, x) => a + x.multiplier * sv(x.id), 0);
    const free = plan.filter((x) => !fixed.has(x.id));
    if (total < cp.target && free.length) fail(`portions-below-request:${cp.kind}`, `${total} < ${cp.target}`);
    if (total < cp.target && !free.length) observe(`short-of-portions-only-postponed-left:${cp.kind}`, `${plan.map((x) => `${x.id}x${x.multiplier}`)}: ${total} < ${cp.target} (page shows « il manque », 410-413)`);
    if (free.length) {
      const fixedPortions = plan.reduce((a, x) => a + (fixed.get(x.id) ?? 0) * sv(x.id), 0);
      const t2 = cp.target - fixedPortions;
      const c = costOf(free.map((x) => sv(x.id)), free.map((x) => x.multiplier), t2);
      if (c !== optimalCost(free.map((x) => sv(x.id)), t2)) fail(`multipliers-not-optimal:${cp.kind}`, `${plan.map((x) => `${x.id}x${x.multiplier}`)} cost ${c} vs ${optimalCost(free.map((x) => sv(x.id)), t2)} for ${t2}`);
    }
    const mine = weekCost(ctx, q.planner, plan, cp.target, fixed);
    if (cp.kind === "swap" && cp.swapBound !== undefined && mine > cp.swapBound + 1e-9) fail("swap-worse-than-every-first-try", `${mine} > ${cp.swapBound}`);
    if (cp.kind === "suggestAll" || cp.kind === "changeSettings") {
      const F = [...fixed.keys()];
      const rest = cp.keep.filter((id) => !fixed.has(id));
      const maxN = Math.max(cp.count, F.length),
        minN = Math.max(1, F.length);
      if (plan.length > maxN) fail(`too-many-recipes:${cp.kind}`, `${plan.length} > ${maxN}`);
      for (const x of plan) {
        const pr = q.planner.find((y) => y.id === x.id)!;
        const isNew = cp.kind === "suggestAll" ? !fixed.has(x.id) : !cp.prevIds.includes(x.id);
        if (!isNew) continue;
        if (!passesFilters(pr, cp.f)) fail(`strict-filter-violated:${cp.kind}`, `${x.id} seasons=${pr.seasons} type=${pr.dishType} filters=${JSON.stringify(cp.f)}`);
        if (pr.active === false || NOT_A_MEAL.has(pr.dishType ?? "")) fail(`inactive-or-side-suggested:${cp.kind}`, x.id);
      }
      // Deterministic draws of planWeek (planner.ts 168-190): for each n, keep = fixed + rest[0..n-F]; when that
      // fills n the draw IS that week. One past the kept recipes, suggest adds a strict-rule candidate if any.
      let best = Infinity;
      let respecting: number | null = null;
      for (let n = minN; n <= maxN; n++) {
        const K = [...F, ...rest.slice(0, n - F.length)];
        if (K.length !== n) continue;
        const c = bestCostOfIds(ctx, q.planner, K, cp.target, fixed);
        best = Math.min(best, c);
        if (respectsRules(K.map((id) => ({ id, multiplier: 1 })), q.planner, ctx.rules)) respecting = Math.min(respecting ?? Infinity, c);
      }
      if (mine > best + 1e-9) fail(`planner-worse-than-deterministic-week:${cp.kind}`, `${mine} > ${best}`);
      const all = [...F, ...rest];
      if (all.length + 1 >= minN && all.length + 1 <= maxN) {
        const allR = all.map((id) => q.planner.find((y) => y.id === id)!);
        const cands = q.planner.filter((c) => !all.includes(c.id) && passesFilters(c, cp.f) && eligibleStrict(c, ctx.rules) && fitsWith(c, allR, ctx.rules));
        if (cands.length) {
          const costs = cands.map((c) => bestCostOfIds(ctx, q.planner, [...all, c.id], cp.target, fixed));
          const bound = Math.max(...costs);
          if (mine > bound + 1e-9) fail(`planner-worse-than-one-more-recipe:${cp.kind}`, `${mine} > ${bound} (${cands.length} candidates)`);
          const resp = cands.filter((c) => respectsRules([...all, c.id].map((id) => ({ id, multiplier: 1 })), q.planner, ctx.rules));
          if (resp.length) respecting = Math.min(respecting ?? Infinity, ...resp.map((c) => bestCostOfIds(ctx, q.planner, [...all, c.id], cp.target, fixed)));
        }
      }
      // PROJET.md: "Une semaine qui respecte les règles de variété passe toujours avant une qui les enfreint" —
      // except that a missing portion costs 100 and a broken rule 1000 (planner.ts 72, 137).
      if (!respectsRules(plan, q.planner, ctx.rules) && respecting !== null) {
        observe(`rule-break-preferred-over-respecting-week-short-of-portions:${cp.kind}`, `${plan.map((x) => `${x.id}x${x.multiplier}`)} cost ${mine}; a rule-respecting week costs ${respecting} (short of portions); rules ${JSON.stringify(ctx.rules)}`);
      }
    }
    if (plan.some((x) => x.multiplier > 6)) observe(`planner-multiplier-above-6:${cp.kind}`, `${plan.map((x) => `${x.id}x${x.multiplier}`)} (the + button stops at 6)`);
  }
}

// ====================================================================================== run
describe("simulation semaine + liste", () => {
  it("listOrder: requested, this week, upcoming soonest first, past latest first (20 000 random sets)", () => {
    const rng = mulberry32(42);
    for (let k = 0; k < 20000; k++) {
      const thisWeek = addWeeks("2026-10-26", Math.floor(rng() * 5) - 2);
      const weeks = [...new Set(Array.from({ length: Math.floor(rng() * 8) }, () => addWeeks("2026-10-26", Math.floor(rng() * 13) - 6)))];
      const plans = weeks.map((w, i) => ({ id: `p${i}`, week_start: w }));
      const requested = rng() < 0.3 ? null : rng() < 0.2 ? "nope" : plans[Math.floor(rng() * plans.length)]?.id ?? null;
      const got = listOrder(plans, requested, thisWeek).map((x) => x.week_start);
      const exp = [
        ...plans.filter((x) => x.id === requested),
        ...plans.filter((x) => x.id !== requested && x.week_start === thisWeek),
        ...plans.filter((x) => x.id !== requested && x.week_start > thisWeek).sort((a, b) => a.week_start.localeCompare(b.week_start)),
        ...plans.filter((x) => x.id !== requested && x.week_start < thisWeek).sort((a, b) => b.week_start.localeCompare(a.week_start)),
      ].map((x) => x.week_start);
      expect(got, JSON.stringify({ plans, requested, thisWeek })).toEqual(exp);
    }
  });

  it("random sessions", async () => {
    const replay = process.env.SIM_SEED ? Number(process.env.SIM_SEED) : null;
    const sessions = Number(process.env.SIM_SESSIONS ?? 4000);
    const seeds = replay !== null ? [replay] : Array.from({ length: sessions }, (_, i) => 1000 + i);
    const t0 = Date.now();
    const realRandom = Math.random;
    try {
      for (const seed of seeds) await runSession(seed, replay !== null);
    } finally {
      Math.random = realRandom;
      setLang("fr");
      fake.reset();
    }
    const secs = ((Date.now() - t0) / 1000).toFixed(1);

    // ---------------------------------------------------------------- 6. summary
    const totalOps = [...opCounts.values()].reduce((a, b) => a + b, 0);
    const lines: string[] = [];
    lines.push(`\n=== Simulation: ${seeds.length} sessions, ${totalOps} operations, ${fake.stats.statements} SQL statements, ${secs} s ===`);
    lines.push("Operations (total / no migration / 0015 only / 0015+0016):");
    for (const [k, v] of [...opCounts].sort((a, b) => b[1] - a[1])) lines.push(`  ${k.padEnd(14)} ${String(v).padStart(6)} ${["none", "0015", "0016"].map((l) => String(tally.get(`op:${k}:${l}`) ?? 0).padStart(6)).join(" ")}`);
    lines.push("rpc calls (function:outcome):");
    for (const [k, v] of Object.entries(fake.stats.rpc).sort()) lines.push(`  ${k.padEnd(28)} ${v}`);
    lines.push("Tallies:");
    for (const [k, v] of [...tally].filter(([k]) => !k.startsWith("op:")).sort()) lines.push(`  ${k.padEnd(52)} ${v}`);
    const byType = new Map<string, Violation[]>();
    for (const v of violations) byType.set(v.type, [...(byType.get(v.type) ?? []), v]);
    lines.push(`Invariant violations: ${violations.length} (${byType.size} types)`);
    for (const [t, vs] of [...byType].sort((a, b) => b[1].length - a[1].length)) {
      const min = vs.reduce((a, b) => (b.log.length < a.log.length ? b : a));
      const seedsOf = [...new Set(vs.map((v) => v.seed))];
      lines.push(`  [${vs.length} in ${seedsOf.length} sessions] ${t}${KNOWN_DEFECTS.has(t) ? "  (KNOWN app defect, see 'open defects')" : ""}`);
      lines.push(`      shortest: SIM_SEED=${min.seed} step ${min.step}: ${min.log.join(" ; ")}`);
      lines.push(`      detail: ${min.detail.slice(0, 400)}`);
    }
    lines.push("Observations (not counted as violations):");
    for (const [t, o] of observations) {
      lines.push(`  [${o.n}] ${t}`);
      lines.push(`      shortest: SIM_SEED=${o.seed} step ${o.step}: ${o.log.join(" ; ")}`);
      lines.push(`      detail: ${o.detail.slice(0, 300)}`);
    }
    console.log(lines.join("\n"));

    if (replay === null) {
      for (const [k, v] of opCounts) expect(v, `operation ${k} exercised`).toBeGreaterThanOrEqual(300);
      expect(opCounts.size, "operation types").toBe(20);
      for (const k of ["save_weeks:ok", "save_weeks:missing", "replace_list:ok", "replace_list:missing", "make_list:ok", "make_list:missing"]) expect(fake.stats.rpc[k] ?? 0, k).toBeGreaterThanOrEqual(300);
      const atomic = [...tally].filter(([k]) => k.startsWith("atomic-ok:")).reduce((a, [, v]) => a + v, 0);
      expect(atomic, "rpc-path saves cut by a lost connection, checked unchanged").toBeGreaterThanOrEqual(300);
    }
    const unexpected = violations.filter((v) => !KNOWN_DEFECTS.has(v.type));
    expect(unexpected.length, `violations (first: ${unexpected[0] ? `SIM_SEED=${unexpected[0].seed} ${unexpected[0].type}` : "-"})`).toBe(0);
  }, 900_000);
});

// ====================================================================================== fake fidelity
describe("fake Supabase behaves like PostgREST and migration 0015", () => {
  it("defaults, missing=default, upsert keeps the id, not-null and int errors", async () => {
    fake.reset(0);
    const sb = fake.client;
    const a = await sb.from("week_plans").upsert({ household_id: HH, week_start: "2026-10-26", suppers: 3, portions: 12, seasons: ["automne"], exclude_dish_types: [] }, { onConflict: "household_id,week_start" }).select("*").single();
    const b = await sb.from("week_plans").upsert({ household_id: HH, week_start: "2026-10-26", suppers: 4, portions: 12, seasons: ["automne"], exclude_dish_types: [] }, { onConflict: "household_id,week_start" }).select("*").single();
    expect((a.data as WeekPlan).id).toBe((b.data as WeekPlan).id);
    expect((b.data as WeekPlan).suppers).toBe(4);
    const pid = (a.data as WeekPlan).id;
    const rows = [{ plan_id: pid, recipe_id: "x", position: 0, multiplier: 1, portions: 4 }, { plan_id: pid, recipe_id: "y", position: 1, multiplier: 1, portions: 4, postponed: true }];
    // Without missing=default the first row's postponed would be NULL: not-null violation (what defaultToNull:false avoids).
    expect((await sb.from("week_plan_recipes").insert(rows).select("*")).error).toMatchObject({ code: "23502" });
    const ok = await sb.from("week_plan_recipes").insert(rows, { defaultToNull: false }).select("*");
    expect(ok.error).toBeNull();
    expect((ok.data as WeekPlanRecipe[]).map((r) => [r.postponed, r.already_bought, r.cooked])).toEqual([[false, false, false], [true, false, false]]);
    expect((await sb.from("week_plan_recipes").insert({ plan_id: pid, recipe_id: "z", multiplier: 1.5, portions: 6 })).error).toMatchObject({ code: "22P02" });
    expect((await sb.from("week_plans").select("*").eq("household_id", HH).maybeSingle()).data).not.toBeNull();
    // The real saveWeek (step by step: PGRST202) round-trips flags through the fake.
    const saved = await saveWeek(HH, "2026-10-26", { portions: 8, recipes: 2, seasons: [], excludeDishTypes: [] }, [{ id: "a", multiplier: 2 }, { id: "b", multiplier: 1 }], () => 4, new Map([["b", { postponed: true, already_bought: true }]]));
    expect(saved.plan.id).toBe(pid);
    expect(saved.items.map((i) => [i.recipe_id, i.multiplier, i.portions, i.postponed, i.already_bought])).toEqual([["a", 2, 8, false, false], ["b", 1, 4, true, true]]);
    expect(fake.stats.rpc["save_weeks:missing"]).toBeGreaterThan(0);
  });

  it("save_weeks and the step-by-step save store the same rows and return the same shape", async () => {
    const run = async (level: 0 | 15) => {
      fake.reset(level);
      const settings = { portions: 12, recipes: 3, seasons: ["automne"], excludeDishTypes: ["soupe"] };
      const flags = new Map([["b", { postponed: true, already_bought: false }]]);
      const r1 = await saveWeeks(HH, [{ week: "2026-10-26", settings, planned: [{ id: "a", multiplier: 2 }, { id: "b", multiplier: 1 }], flags }, { week: "2026-11-02", settings: { ...settings, seasons: [] }, planned: [] }], () => 4);
      const r2 = await saveWeek(HH, "2026-10-26", { ...settings, portions: 4 }, [{ id: "b", multiplier: 1 }], () => 4, flags);
      return { r1, r2, tables: structuredClone(fake.tables) };
    };
    const viaRpc = await run(15);
    const steps = await run(0);
    expect(viaRpc.r1).toEqual(steps.r1);
    expect(viaRpc.r2).toEqual(steps.r2);
    expect(viaRpc.tables).toEqual(steps.tables);
    expect(viaRpc.r2.items.map((i) => [i.recipe_id, i.postponed, i.already_bought])).toEqual([["b", true, false]]);
  });

  it("replace_list keeps generated ticks, ignores manual ticks, keeps manual items (both paths)", async () => {
    for (const level of [16, 15, 0] as const) {
      const rpc = level;
      fake.reset(level);
      const recipes = BASE_RECIPES.filter((r) => r.id === "zz-maison");
      const saved = await saveWeek(HH, "2026-10-26", { portions: 4, recipes: 1, seasons: [], excludeDishTypes: [] }, [{ id: "zz-maison", multiplier: 1 }], () => 4);
      const pid = saved.plan.id;
      await generateList(pid, saved.items, recipes, INGREDIENTS, CATALOG);
      const gen = fake.tables.shopping_items.filter((x) => !x.manual);
      const tofu = gen.find((x) => x.ingredient_id === "Tofu ferme")!;
      tofu.checked = true;
      const truc = gen.find((x) => x.ingredient_id === null && String(x.label).startsWith("Truc"))!;
      // A manual item with the same label as an uncatalogued generated line, ticked.
      await fake.client.from("shopping_items").insert({ plan_id: pid, label: truc.label, aisle: "autre", manual: true, position: 9999, checked: true });
      await generateList(pid, saved.items, recipes, INGREDIENTS, CATALOG);
      const after = fake.tables.shopping_items;
      expect(after.find((x) => !x.manual && x.ingredient_id === "Tofu ferme")?.checked, `rpc=${rpc}`).toBe(true);
      expect(after.find((x) => !x.manual && x.label === truc.label)?.checked, `rpc=${rpc}`).toBe(false);
      expect(after.filter((x) => x.manual).length).toBe(1);
      expect(await listStatus(pid, saved.items, recipes, INGREDIENTS, CATALOG)).toBe("current");
    }
  });

  it("a lost connection inside save_weeks / replace_list / make_list rolls the whole transaction back", async () => {
    fake.reset(16);
    const settings = { portions: 8, recipes: 2, seasons: [], excludeDishTypes: [] };
    const R0 = BASE_RECIPES[0];
    await saveWeeks(HH, [{ week: "2026-10-26", settings, planned: [{ id: R0.id, multiplier: 2 }] }], () => 4);
    for (let during = 1; during <= 8; during++) {
      const snap = JSON.stringify(fake.tables);
      fake.arm(1, during);
      await expect(saveWeeks(HH, [{ week: "2026-10-26", settings, planned: [{ id: "b", multiplier: 1 }] }, { week: "2026-11-02", settings, planned: [{ id: "a", multiplier: 1 }] }], () => 4)).rejects.toMatchObject({ code: "08006" });
      expect(fake.disarm()).toBe("rpc save_weeks");
      expect(JSON.stringify(fake.tables)).toBe(snap);
    }
    const plan = planOf("2026-10-26")!;
    const recipes = [R0];
    await generateList(plan.id, itemsOfWeek("2026-10-26"), recipes, INGREDIENTS, CATALOG);
    fake.tables.shopping_items[0].checked = true;
    expect(fake.tables.shopping_items.length).toBeGreaterThan(1);
    for (let during = 0; during <= 4; during++) {
      const snap = JSON.stringify(fake.tables);
      fake.arm(1, during);
      await expect(generateList(plan.id, itemsOfWeek("2026-10-26"), recipes, INGREDIENTS, CATALOG)).rejects.toMatchObject({ code: "08006" });
      fake.disarm();
      expect(JSON.stringify(fake.tables)).toBe(snap);
    }
    // An SQL error inside the function (not-null on suppers) also rolls back the first week already written.
    const snap = JSON.stringify(fake.tables);
    await expect(saveWeeks(HH, [{ week: "2026-10-26", settings: { ...settings, portions: 99 }, planned: [] }, { week: "2026-11-09", settings: { ...settings, recipes: null as unknown as number }, planned: [] }], () => 4)).rejects.toMatchObject({ code: "23502" });
    expect(JSON.stringify(fake.tables)).toBe(snap);
    // make_list on a plan that does not exist: 'plan introuvable', nothing written.
    await expect(generateList("no-such-plan", itemsOfWeek("2026-10-26"), recipes, INGREDIENTS, CATALOG)).rejects.toMatchObject({ code: expect.stringMatching(/^(23503|P0001)$/) }); // the insert's foreign key fails first
    expect(JSON.stringify(fake.tables)).toBe(snap);
  });

  it("0016: removing ticked generated lines keeps the list current; a recipe change still makes it stale", async () => {
    const out: Record<number, string[]> = {};
    for (const level of [16, 15, 0] as const) {
      fake.reset(level);
      setLang("fr");
      const recipes = BASE_RECIPES.slice(0, 2);
      const saved = await saveWeek(HH, "2026-10-26", { portions: 8, recipes: 2, seasons: [], excludeDishTypes: [] }, recipes.map((r) => ({ id: r.id, multiplier: 1 })), () => 4);
      const pid = saved.plan.id;
      const st = () => listStatus(pid, itemsOfWeek("2026-10-26"), recipes, INGREDIENTS, CATALOG);
      const seq = [await st()];
      await generateList(pid, saved.items, recipes, INGREDIENTS, CATALOG);
      seq.push(await st());
      const gen = fake.tables.shopping_items.filter((x) => !x.manual);
      await listeToggle(gen[0] as unknown as ShoppingItem);
      await listeClearChecked(fake.tables.shopping_items.map((x) => ({ ...x })) as unknown as ShoppingItem[]);
      seq.push(await st());
      // Every generated line cleared.
      for (const x of fake.tables.shopping_items) x.checked = true;
      await listeClearChecked(fake.tables.shopping_items.map((x) => ({ ...x })) as unknown as ShoppingItem[]);
      seq.push(await st());
      await saveWeek(HH, "2026-10-26", { portions: 8, recipes: 2, seasons: [], excludeDishTypes: [] }, [{ id: recipes[0].id, multiplier: 2 }, { id: recipes[1].id, multiplier: 1 }], () => 4);
      seq.push(await st());
      out[level] = seq;
    }
    expect(out[16]).toEqual(["none", "current", "current", "current", "stale"]);
    // Without 0016 the stored lines are compared: clearing ticked lines makes Semaine say "out of date" (known, fixed by 0016).
    expect(out[15]).toEqual(["none", "current", "stale", "none", "none"]);
    expect(out[0]).toEqual(out[15]);
  });
});

// ====================================================================================== regressions
// The reproductions of the first audit (each asserts what PROJET.md "Semaine" asks for); they failed before 15e6a65
// and must pass now, with and without migration 0015.
for (const level of [16, 15, 0] as const) {
  const rpc = level >= 15;
  describe(`regressions of the first audit (migrations: ${pathName(level)})`, () => {
    const W = "2026-10-26";
    const mk = () => {
      fake.reset(level);
      setLang("fr");
      const recipes = BASE_RECIPES.map((r) => ({ ...r }));
      const ctx: Ctx = { kitchen: { recipes, ingredients: INGREDIENTS, catalog: CATALOG }, rules: { maxSameDishType: 2, maxSameProtein: 3, cooldownWeeks: 0 }, recipeById: new Map(recipes.map((r) => [r.id, r])), thisWeek: W };
      return ctx;
    };
    // Three 4-portion recipes of the book.
    const four = BASE_RECIPES.filter((r) => r.servings === 4 && r.active && r.dish_type !== "accompagnement").map((r) => r.id);
    const [A, B, C] = [four[0], four[5], four[10]];

    it("suggestAll on a week with two postponed recipes keeps both (page.tsx 213-218, planner.ts planWeek fixed)", async () => {
      const ctx = mk();
      const p = await loadPage(ctx, 0);
      await changeSettings(ctx, p, { ...p.settings, portions: 4 });
      await add(ctx, p, A);
      await add(ctx, p, B);
      expect(await postpone(ctx, p, A, true)).toBe("ok");
      expect(await postpone(ctx, p, B, true)).toBe("ok");
      const n = await loadPage(ctx, 1); // W+1: A x1, B x1 (both postponed, already bought), 4 portions asked
      expect(n.items.map((i) => i.recipe_id)).toEqual([A, B]);
      await suggestAll(ctx, n);
      expect(n.items.map((i) => i.recipe_id).sort()).toEqual([A, B].sort());
      expect(n.items.every((i) => i.multiplier === 1 && i.postponed && i.already_bought)).toBe(true);
    });

    it("raising the maximum of recipes keeps the postponed recipe (page.tsx 220-234)", async () => {
      const ctx = mk();
      const n0 = await loadPage(ctx, 1);
      await changeSettings(ctx, n0, { ...n0.settings, portions: 4 });
      await add(ctx, n0, B); // W+1: B x1, 4 portions, max 5 recipes
      const p = await loadPage(ctx, 0);
      await add(ctx, p, A);
      expect(await postpone(ctx, p, A, true)).toBe("ok"); // W+1: B, A (postponed, bought)
      const n = await loadPage(ctx, 1);
      expect(n.items.map((i) => i.recipe_id)).toEqual([B, A]);
      await changeSettings(ctx, n, { ...n.settings, recipes: n.settings.recipes + 1 });
      expect(n.items.map((i) => i.recipe_id)).toContain(A);
    });

    it("a postponed, already-bought recipe keeps its multiplier when another recipe is removed (page.tsx 211, 243)", async () => {
      const ctx = mk();
      const n0 = await loadPage(ctx, 1);
      await changeSettings(ctx, n0, { ...n0.settings, portions: 12 });
      await add(ctx, n0, B); // W+1: B x3
      const p = await loadPage(ctx, 0);
      await add(ctx, p, A);
      await setMultiplier(ctx, p, A, 2);
      expect(await postpone(ctx, p, A, true)).toBe("ok"); // W+1: B x3, A x2 (bought for x2)
      const n = await loadPage(ctx, 1);
      expect(n.items.find((i) => i.recipe_id === A)?.multiplier).toBe(2);
      await remove(ctx, n, B);
      // Its ingredients stay off the list (already_bought) whatever the multiplier: x3 would mean a third is not bought.
      expect(n.items.find((i) => i.recipe_id === A)?.multiplier).toBe(2);
      // Adding a recipe and changing the portions do not re-multiply it either.
      await add(ctx, n, C);
      await changeSettings(ctx, n, { ...n.settings, portions: 30 });
      expect(n.items.find((i) => i.recipe_id === A)?.multiplier).toBe(2);
    });

    it("swap prefers a replacement that respects the variety rules (planner.ts swapInPlan)", () => {
      const pr = (id: string, protein: string, dishType: string, servings: number): PlannerRecipe => ({ id, servings, dishType, protein, seasons: ALL_SEASONS, rating: null, ingredientIds: [], weeksSinceEaten: null, active: true });
      const recipes = [pr("X", "tofu", "bol", 4), pr("Y", "lentilles", "soupe", 4), pr("G", "pois chiches", "salade", 6), ...["riz", "four", "wrap", "plaque", "ramen"].map((d, i) => pr(`T${i}`, "tofu", d, 4))];
      const rules: Rules = { maxSameDishType: 2, maxSameProtein: 1, cooldownWeeks: 0 };
      for (let seed = 1; seed <= 200; seed++) {
        const res = swapInPlan(recipes, [{ id: "X", multiplier: 1 }, { id: "Y", multiplier: 1 }], "Y", 8, rules, "automne", { random: mulberry32(seed) })!;
        // [X, G] respects the rules (12 portions for 8); [X, T*] has two tofu recipes (max 1) but exactly 8 portions.
        expect(respectsRules(res, recipes, rules), `seed ${seed}`).toBe(true);
      }
    });

    it("postponing saves both weeks at once: the recipe is never in both weeks, nor in neither, when the save fails", async () => {
      const ctx = mk();
      const p = await loadPage(ctx, 0);
      await add(ctx, p, A);
      await add(ctx, p, B);
      for (let k = 1; k <= 12; k++) {
        const snap = JSON.stringify(fake.tables);
        fake.arm(k, rpc ? 1 + (k % 3) : 0);
        const res = await postpone(ctx, p, A, false);
        const fired = fake.disarm();
        const inW = itemsOfWeek(W).some((i) => i.recipe_id === A),
          inW1 = itemsOfWeek(nextWeekOf(W)).some((i) => i.recipe_id === A);
        if (!fired) {
          expect(res).toBe("ok");
          expect([inW, inW1]).toEqual([false, true]);
          break;
        }
        expect(res).toBe("error");
        if (rpc) expect(JSON.stringify(fake.tables)).toBe(snap);
        else if (inW && inW1) {
          // Without the migration, a cut between the two step-by-step saves leaves the recipe in both weeks:
          // expected until 0015 is applied (weekPlan.ts saveWeeks fallback). Undo and go on.
          fake.reset(level);
          return;
        }
      }
    });
  });
}

// ====================================================================================== fixed after the second audit
// A failed save used to leave the changed settings on screen (page.tsx 221 / 250 set them before the save); the next
// filters-only change then saved more recipes than the maximum. Fixed by resync (page.tsx 192, 198-208, 274).
for (const level of [16, 15, 0] as const) {
  it(`a failed save of « Recettes (au plus) » shows the saved settings again; the next change keeps recipes <= maximum (migrations: ${pathName(level)})`, async () => {
    fake.reset(level);
    setLang("fr");
    const recipes = BASE_RECIPES.map((r) => ({ ...r }));
    const ctx: Ctx = { kitchen: { recipes, ingredients: INGREDIENTS, catalog: CATALOG }, rules: { maxSameDishType: 9, maxSameProtein: 9, cooldownWeeks: 0 }, recipeById: new Map(recipes.map((r) => [r.id, r])), thisWeek: "2026-10-26" };
    const p = await loadPage(ctx, 0);
    await suggestAll(ctx, p); // 5 recipes, max 5
    expect(p.items.length).toBe(5);
    fake.arm(1); // the network drops on the first request of the save of "max 4"
    await changeSettings(ctx, p, { ...p.settings, recipes: 4 });
    expect(fake.disarm()).toBe("rpc save_weeks"); // without 0015 too: the save_weeks probe is the first request
    expect(p.error).not.toBeNull();
    expect(p.settings.recipes).toBe(5); // the stepper shows the saved maximum again
    expect(p.items.length).toBe(5);
    await changeSettings(ctx, p, { ...p.settings, seasons: toggleIn(p.settings.seasons, "hiver") }); // filters only: saves current + settings
    const plan = planOf("2026-10-26")!;
    expect(itemsOfWeek("2026-10-26").length).toBeLessThanOrEqual(plan.suppers);
  });
}
