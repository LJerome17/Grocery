// Live audit of week plans, postponing and grocery lists against the real Supabase database (public key only).
// Two throw-away anonymous households (never the recipe book): A runs hundreds of random page-like operations through
// the real src/lib code; B probes A's rows (and A probes B's) to check row-level security. Everything is cleaned up.
// Since migration 0015: saves go through save_weeks / replace_list (asserted: no PGRST202, no step-by-step writes),
// postponed recipes stay fixed with their multiplier, listStatus, and atomicity / RLS of the two functions.
// Usage: npx tsx scripts/audit/live-ops.ts [--seed N] [--ops N] [--minutes M] [--atomic N]
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { SUPABASE_KEY, SUPABASE_URL } from "../../src/lib/supabase";

// ---------- The real libraries use a browser client (src/lib/supabase.ts) that has no session in Node. ----------
// Its REST requests are sent with the access token of the household being driven (A), so the libraries run unchanged.
const realFetch = globalThis.fetch.bind(globalThis);
let libToken = "";
let requests = 0;
const RAW = "x-audit-raw";
/**
 * Fault injection: the next request matching this (path fragment, method) fails like a dropped connection, either
 * before it reaches the server ("before") or after the server answered (the response is lost: "after").
 */
let injectFault: { path: string; method: string; when?: "before" | "after" } | null = null;
/** Requests made by the real libraries (not the audit's own clients), by "METHOD /path". */
const libCalls = new Map<string, number>();
/** Library writes that bypass the rpc functions (the step-by-step fallback of weekPlan.ts): must stay empty. */
const fallbackWrites: string[] = [];
/** Any rpc answered PGRST202 (function missing): must stay empty once migration 0015 is applied. */
const pgrst202: string[] = [];
/** make_list (migration 0016) answered PGRST202: expected until 0016 is applied (the library then uses replace_list). */
let makeList202 = 0;
/** Whether make_list exists live (probed at setup): lists then carry a signature and listStatus uses it. */
let hasMakeList = false;
/** The rpc the library makes lists with live. */
let listRpc = "replace_list";
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  requests++;
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const rest = url.startsWith(`${SUPABASE_URL}/rest/v1/`);
  if (rest) {
    const path = new URL(url).pathname.replace("/rest/v1", "");
    if (headers.has(RAW)) headers.delete(RAW);
    else {
      headers.set("Authorization", `Bearer ${libToken}`);
      libCalls.set(`${method} ${path}`, (libCalls.get(`${method} ${path}`) ?? 0) + 1);
      if (method !== "GET" && !path.startsWith("/rpc/")) fallbackWrites.push(`${method} ${path}`);
    }
    init = { ...init, headers };
  }
  let lost = false;
  if (injectFault && url.includes(injectFault.path) && method === injectFault.method) {
    lost = injectFault.when === "after";
    injectFault = null;
    if (!lost) throw new TypeError("fetch failed (injected by the audit)");
  }
  const res = await realFetch(input, init);
  if (rest && url.includes("/rest/v1/rpc/") && res.status >= 400) {
    const body = await res.clone().text();
    if (body.includes("PGRST202") && /\/rpc\/(save_weeks|replace_list)\b/.test(url)) pgrst202.push(`${method} ${new URL(url).pathname}: ${body.slice(0, 200)}`);
    if (body.includes("PGRST202") && /\/rpc\/make_list\b/.test(url)) makeList202++;
  }
  if (lost) {
    await res.arrayBuffer().catch(() => undefined);
    throw new TypeError("fetch failed after the server answered (injected by the audit)");
  }
  return res;
}) as typeof fetch;

const BOOK_HOUSEHOLD = "b709e1e1-cacb-42d4-b75d-f458d6e112e2";

// ---------- Arguments, seeded random ----------
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const SEED = Number(arg("seed") ?? Date.now() % 1_000_000_007);
const MAX_OPS = Number(arg("ops") ?? 3000);
const MAX_MINUTES = Number(arg("minutes") ?? 5);
function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rnd = mulberry32(SEED);
const int = (lo: number, hi: number) => lo + Math.floor(rnd() * (hi - lo + 1));
const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)];
const chance = (p: number) => rnd() < p;
const shuffle = <T>(a: T[]): T[] => {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [b[i], b[j]] = [b[j], b[i]];
  }
  return b;
};

// ---------- Types ----------
type Row = Record<string, unknown>;
type ExpItem = { recipe_id: string; multiplier: number; postponed: boolean; already_bought: boolean };
type ExpPlan = { suppers: number; portions: number; seasons: string[]; exclude: string[]; items: ExpItem[] };
type ListRow = { id: string; plan_id: string; ingredient_id: string | null; label: string; quantity_text: string | null; aisle: string; pantry: boolean; manual: boolean; checked: boolean; position: number };

const counts = new Map<string, number>();
const bump = (k: string, n = 1) => counts.set(k, (counts.get(k) ?? 0) + n);
type Failure = { op: number; type: string; message: string; repro: string[] };
const failures: Failure[] = [];
const flaky: { op: number; type: string; message: string }[] = [];
const notes = new Map<string, number>();
const note = (k: string) => notes.set(k, (notes.get(k) ?? 0) + 1);
const opLog: string[] = [];
let doneCounts = new Map<string, number>();
let opNo = 0;
let curType = "setup";
const fail = (message: string) => {
  failures.push({ op: opNo, type: curType, message, repro: opLog.slice(-6) });
  console.log(`FAIL  #${opNo} ${curType}: ${message}`);
};
/** Rows of a household, in a stable order, as text. */
const snapshot = (plans: (Row & { week_plan_recipes: { id: string }[]; shopping_items: { id: string }[] })[]) =>
  JSON.stringify(
    plans
      .map((p) => ({ ...p, week_plan_recipes: [...p.week_plan_recipes].sort((a, b) => a.id.localeCompare(b.id)), shopping_items: [...p.shopping_items].sort((a, b) => a.id.localeCompare(b.id)) }))
      .sort((a, b) => String((a as Row).id).localeCompare(String((b as Row).id))),
  );

function rawClient() {
  return createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { [RAW]: "1" } } });
}
const must = <T>(r: { data: T; error: unknown }, what = "") => {
  if (r.error) throw Object.assign(new Error(`${what}: ${JSON.stringify(r.error)}`), { cause: r.error });
  return r.data;
};
const isNetwork = (e: unknown) => {
  const s = String(e instanceof Error ? `${e.message} ${JSON.stringify(e.cause ?? "")}` : JSON.stringify(e));
  return /fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND|socket|network|timeout|EAI_AGAIN|502|503|504|Bad Gateway|upstream/i.test(s);
};

async function main() {
  const lib = await import("../../src/lib/weekPlan");
  const data = await import("../../src/lib/data");
  const planner = await import("../../src/lib/planner");
  const shopping = await import("../../src/lib/shopping");
  const { NO_AISLE } = await import("../../src/lib/aisles");
  const { nameKey } = await import("../../src/lib/text");
  const { DISH_TYPES } = await import("../../src/lib/db");
  type WPR = import("../../src/lib/db").WeekPlanRecipe;
  type WeekSettings = import("../../src/lib/weekPlan").WeekSettings;

  console.log(`seed ${SEED}  ops ≤ ${MAX_OPS}  time ≤ ${MAX_MINUTES} min`);
  const t0 = Date.now();

  // ---------- Two anonymous visitors, one household each ----------
  const sbA = rawClient();
  const sbB = rawClient();
  const sessA = must(await sbA.auth.signInAnonymously(), "sign in A").session!;
  const sessB = must(await sbB.auth.signInAnonymously(), "sign in B").session!;
  libToken = sessA.access_token;
  const userA = sessA.user.id;
  const userB = sessB.user.id;
  const H1 = must(await sbA.rpc("create_household", { p_name: "TEST audit live-ops A (à supprimer)", p_display_name: "audit" }), "household A") as string;
  const H2 = must(await sbB.rpc("create_household", { p_name: "TEST audit live-ops B (à supprimer)", p_display_name: "audit" }), "household B") as string;
  if (H1 === BOOK_HOUSEHOLD || H2 === BOOK_HOUSEHOLD) throw new Error("refuse to run on the book");
  console.log(`households A=${H1} B=${H2}`);

  const THIS = planner.weekStart(new Date());
  const NEXT = lib.nextWeekOf(THIS);
  const [ty, tm, td] = THIS.split("-").map(Number);
  const PAST = planner.weekStart(new Date(ty, tm - 1, td - 7));
  const WEEKS = [PAST, THIS, NEXT];
  console.log(`weeks past=${PAST} this=${THIS} next=${NEXT}`);

  try {
    // ---------- The book, read like the page (useKitchen) ----------
    const recipes = await data.loadRecipes();
    const catalog = await data.loadCatalog();
    const ingredients = await data.loadRecipeIngredients(recipes.map((r) => r.id));
    const bookIds = new Set(recipes.map((r) => r.household_id));
    console.log(`book: ${recipes.length} recipes (households ${[...bookIds].join(",")}), ${ingredients.length} ingredient lines, ${catalog.length} catalogue articles`);
    if (!bookIds.has(BOOK_HOUSEHOLD) || bookIds.size !== 1) console.log(`NOTE  recipes are not all from ${BOOK_HOUSEHOLD}`);
    const recipeById = new Map(recipes.map((r) => [r.id, r]));
    const sv = (id: string) => lib.servingsOf(recipeById.get(id));
    const pool = recipes.filter((r) => r.active !== false && !planner.NOT_A_MEAL.has(r.dish_type ?? "")).map((r) => r.id);
    const ingByRecipe = new Map<string, typeof ingredients>();
    for (const i of ingredients) ingByRecipe.set(i.recipe_id, [...(ingByRecipe.get(i.recipe_id) ?? []), i]);
    const catById = new Map(catalog.map((c) => [c.id, c]));
    const globalByName = new Map(catalog.filter((c) => c.household_id === null).map((c) => [c.name, c]));
    const juiceOf = new Map<string, string>();
    for (const [fruit, juice] of [["Citron", "Jus de citron"], ["Lime", "Jus de lime"]]) {
      const f = globalByName.get(fruit), j = globalByName.get(juice);
      if (f && j) juiceOf.set(f.id, j.id);
    }
    const SEASONS = Object.keys(planner.SEASON_LABEL);
    // Like the page: planner recipes with the household's history before the week shown; default variety rules.
    const rules = { maxSameDishType: 1, maxSameProtein: 2, cooldownWeeks: 3 };
    const plannerFor = async (w: string) => data.toPlannerRecipes(recipes, ingredients, catalog, await data.loadHistory(H1, w));

    // ---------- Model: what the database must hold ----------
    const expected = new Map<string, ExpPlan>();
    const planIds = new Map<string, string>();
    let listSnap = new Map<string, ListRow[]>(); // plan id -> rows, last verified
    // What the page shows for each week (as returned by saveWeek / loadWeek); null = the page must load it first.
    const page = new Map<string, { settings: WeekSettings; items: WPR[] } | null>();

    async function readAll(sb: SupabaseClient, household: string) {
      const plans = must(
        await sb.from("week_plans").select("*, week_plan_recipes(*), shopping_items(*)").eq("household_id", household),
        "read all",
      ) as (Row & { week_plan_recipes: WPR[]; shopping_items: ListRow[] })[];
      return plans;
    }

    /** Compare the database with the model; on a mismatch, report and take the database as the new truth. */
    async function verify(extra?: (plans: Awaited<ReturnType<typeof readAll>>) => void) {
      bump("verify");
      const plans = await readAll(sbA, H1);
      const before = failures.length;
      const byWeek = new Map<string, (typeof plans)[number][]>();
      for (const p of plans) byWeek.set(p.week_start as string, [...(byWeek.get(p.week_start as string) ?? []), p]);
      for (const [w, ps] of byWeek) if (ps.length > 1) fail(`${ps.length} plans for (household, ${w})`);
      const weeksDb = [...byWeek.keys()].sort().join(",");
      const weeksExp = [...expected.keys()].sort().join(",");
      if (weeksDb !== weeksExp) fail(`plan weeks ${weeksDb} ≠ expected ${weeksExp}`);
      for (const [w, exp] of expected) {
        const p = byWeek.get(w)?.[0];
        if (!p) continue;
        if (planIds.has(w) && planIds.get(w) !== p.id) fail(`plan id of ${w} changed ${planIds.get(w)} → ${p.id}`);
        planIds.set(w, p.id as string);
        if (p.suppers !== exp.suppers || Number(p.portions) !== exp.portions) fail(`${w} settings suppers/portions ${p.suppers}/${p.portions} ≠ ${exp.suppers}/${exp.portions}`);
        if (JSON.stringify(p.seasons) !== JSON.stringify(exp.seasons)) fail(`${w} seasons ${JSON.stringify(p.seasons)} ≠ ${JSON.stringify(exp.seasons)}`);
        if (JSON.stringify(p.exclude_dish_types) !== JSON.stringify(exp.exclude)) fail(`${w} exclude ${JSON.stringify(p.exclude_dish_types)} ≠ ${JSON.stringify(exp.exclude)}`);
        const items = [...p.week_plan_recipes].sort((a, b) => a.position - b.position);
        const got = items.map((i) => `${i.recipe_id.slice(0, 8)}×${i.multiplier}${i.postponed ? "P" : ""}${i.already_bought ? "B" : ""}`).join(" ");
        const want = exp.items.map((i) => `${i.recipe_id.slice(0, 8)}×${i.multiplier}${i.postponed ? "P" : ""}${i.already_bought ? "B" : ""}`).join(" ");
        if (got !== want) fail(`${w} recipes [${got}] ≠ expected [${want}]`);
        items.forEach((i, k) => {
          if (i.position !== k) fail(`${w} positions not 0..n-1: ${items.map((x) => x.position).join(",")}`);
          if (Number(i.portions) !== i.multiplier * sv(i.recipe_id)) fail(`${w} portions of ${i.recipe_id} = ${i.portions}, expected ${i.multiplier}×${sv(i.recipe_id)}`);
          if (typeof i.postponed !== "boolean" || typeof i.already_bought !== "boolean") fail(`${w} flags not boolean: ${i.postponed}/${i.already_bought}`);
        });
        if (new Set(items.map((i) => i.recipe_id)).size !== items.length) fail(`${w} has a recipe twice`);
        const pg = page.get(w);
        if (pg) {
          const shown = pg.items.map((i) => `${i.recipe_id.slice(0, 8)}×${i.multiplier}${i.postponed ? "P" : ""}${i.already_bought ? "B" : ""}`).join(" ");
          if (shown !== got) fail(`${w} page shows [${shown}] but database has [${got}]`);
        }
        // Lists: exactly the last verified rows unless the operation changed them (callers update listSnap first).
        const want2 = listSnap.get(p.id as string) ?? [];
        const got2 = p.shopping_items;
        const key = (r: ListRow) => `${r.manual ? "M" : "G"}|${r.ingredient_id ?? ""}|${r.label}|${r.quantity_text ?? ""}|${r.aisle}|${r.pantry}|${r.checked}|${r.position}`;
        const ms = (rs: ListRow[]) => rs.map(key).sort().join("\n");
        if (ms(got2) !== ms(want2)) {
          const a = new Set(got2.map(key)), b = new Set(want2.map(key));
          fail(`${w} list differs: unexpected [${[...a].filter((x) => !b.has(x)).slice(0, 4).join(" ; ")}] missing [${[...b].filter((x) => !a.has(x)).slice(0, 4).join(" ; ")}]`);
        }
        // Manual rows keep their ids.
        const gotIds = new Set(got2.map((r) => r.id));
        for (const r of want2) if (r.manual && r.id && !gotIds.has(r.id)) fail(`${w} manual row "${r.label}" (${r.id}) disappeared`);
      }
      extra?.(plans);
      if (failures.length > before) {
        // Resync so one defect does not cascade.
        for (const p of plans) {
          const items = [...p.week_plan_recipes].sort((a, b) => a.position - b.position);
          expected.set(p.week_start as string, {
            suppers: p.suppers as number,
            portions: Number(p.portions),
            seasons: p.seasons as string[],
            exclude: p.exclude_dish_types as string[],
            items: items.map((i) => ({ recipe_id: i.recipe_id, multiplier: i.multiplier, postponed: !!i.postponed, already_bought: !!i.already_bought })),
          });
          page.set(p.week_start as string, null);
        }
      }
      listSnap = new Map(plans.map((p) => [p.id as string, p.shopping_items]));
      return plans;
    }

    const flagsFrom = (items: WPR[]) => lib.flagsOf(items);
    const expFromPlanned = (planned: { id: string; multiplier: number }[], flags: Map<string, { postponed?: boolean; already_bought?: boolean }>): ExpItem[] =>
      planned.map((p) => ({ recipe_id: p.id, multiplier: p.multiplier, postponed: !!flags.get(p.id)?.postponed, already_bought: !!flags.get(p.id)?.already_bought }));

    /** The page opened on week w (chip): loadWeek, like its effect. */
    async function openWeek(w: string) {
      const r = await lib.loadWeek(H1, w);
      bump("loadWeek");
      const settings: WeekSettings = r.plan
        ? { portions: r.plan.portions ?? 20, recipes: r.plan.suppers, seasons: r.plan.seasons ?? [planner.seasonOf(new Date(`${w}T12:00:00`))], excludeDishTypes: r.plan.exclude_dish_types ?? [] }
        : { portions: 20, recipes: 5, seasons: [planner.seasonOf(new Date(`${w}T12:00:00`))], excludeDishTypes: [] };
      page.set(w, { settings, items: r.items });
      return page.get(w)!;
    }
    const pageOf = async (w: string) => page.get(w) ?? (await openWeek(w));

    /** persist() of the page. */
    async function persist(w: string, planned: { id: string; multiplier: number }[], s: WeekSettings, flags = flagsFrom(page.get(w)!.items)) {
      const saved = await lib.saveWeek(H1, w, s, planned, sv, flags);
      bump("saveWeek(call)");
      checkSaved(w, saved, s, planned, flags, "saveWeek");
      page.set(w, { settings: s, items: saved.items });
      expected.set(w, { suppers: s.recipes, portions: s.portions, seasons: s.seasons, exclude: s.excludeDishTypes, items: expFromPlanned(planned, flags) });
      return saved;
    }
    /** What save_weeks returned for one week: the plan and its recipes in order, flags round-tripped as booleans. */
    function checkSaved(
      w: string,
      saved: { plan: { id: string; week_start: string; suppers: number; portions: number | null }; items: WPR[] },
      s: WeekSettings,
      planned: { id: string; multiplier: number }[],
      flags: Map<string, { postponed?: boolean; already_bought?: boolean }>,
      what: string,
    ) {
      bump("savedReturnChecks");
      if (!saved?.plan?.id) return fail(`${what} ${w}: no plan returned (${JSON.stringify(saved).slice(0, 200)})`);
      if (saved.plan.week_start !== w) fail(`${what} ${w}: returned plan of ${saved.plan.week_start}`);
      if (planIds.has(w) && planIds.get(w) !== saved.plan.id) fail(`${what} ${w}: plan id ${saved.plan.id} ≠ ${planIds.get(w)}`);
      if (saved.plan.suppers !== s.recipes || Number(saved.plan.portions) !== s.portions) fail(`${what} ${w}: returned settings ${saved.plan.suppers}/${saved.plan.portions}`);
      const got = saved.items.map((i) => `${i.position}:${i.recipe_id}×${i.multiplier}=${Number(i.portions)}${i.postponed === true ? "P" : i.postponed === false ? "" : "?"}${i.already_bought === true ? "B" : i.already_bought === false ? "" : "?"}`).join(" ");
      const want = planned.map((p, k) => `${k}:${p.id}×${p.multiplier}=${p.multiplier * sv(p.id)}${flags.get(p.id)?.postponed ? "P" : ""}${flags.get(p.id)?.already_bought ? "B" : ""}`).join(" ");
      if (got !== want) fail(`${what} ${w}: returned items [${got}] ≠ sent [${want}]`);
      if (flags.size && [...flags.values()].some((f) => f.postponed || f.already_bought)) bump("flagsRoundTrip(non-trivial)");
    }
    /** Postponed recipes keep their multiplier (fixedOf): the page's refit. */
    const refit = (ids: string[], portions: number, items: WPR[]) => planner.fitMultipliers(ids, sv, portions, lib.fixedOf(items));
    /**
     * Postponed recipes are never dropped nor re-multiplied by an operation on another recipe (`except`: the recipe
     * the user acted on, which ✕, swap or its own − / + may change).
     */
    function checkFixedKept(w: string, before: WPR[], planned: { id: string; multiplier: number }[], what: string, except?: string) {
      for (const [id, m] of lib.fixedOf(before)) {
        if (id === except) continue;
        bump("fixedKeptChecks");
        const p = planned.find((x) => x.id === id);
        if (!p) fail(`${what} ${w}: postponed recipe ${id.slice(0, 8)}×${m} dropped`);
        else if (p.multiplier !== m) fail(`${what} ${w}: postponed recipe ${id.slice(0, 8)} multiplier ${m} → ${p.multiplier}`);
      }
    }
    /** Plan id -> sorted "label|quantity" of the lines its list was last made from (only when make_list exists). */
    const madeFrom = new Map<string, string[]>();
    /** The list status the page shows (listStatus), against the model: none / current / stale. */
    async function checkListStatus(w: string) {
      const planId = planIds.get(w);
      const pg = page.get(w);
      if (!planId || !pg) return;
      const status = await lib.listStatus(planId, pg.items, recipes, ingredients, catalog);
      const stored = (listSnap.get(planId) ?? []).filter((r) => !r.manual);
      const label = (l: ReturnType<typeof expectedLines>[number]) => (l.optional ? `${l.label} (facultatif)` : l.label);
      const b = expectedLines(pg.items).map((l) => `${label(l)}|${l.quantityText ?? ""}`).sort();
      const same = (a: string[]) => a.length === b.length && a.every((k, i) => k === b[i]);
      // With migration 0016 a list made by make_list is judged by what it was made from (removing bought lines
      // does not make it stale); otherwise by the generated lines stored now.
      const made = madeFrom.get(planId);
      const want = made ? (same(made) ? "current" : "stale") : !stored.length ? "none" : same(stored.map((r) => `${r.label}|${r.quantity_text ?? ""}`).sort()) ? "current" : "stale";
      bump(`listStatus:${status}`);
      if (status !== want) fail(`listStatus ${w} = ${status}, expected ${want}`);
    }
    const currentOf = (pg: { items: WPR[] }) => pg.items.map((i) => ({ id: i.recipe_id, multiplier: i.multiplier || 1 }));
    const season = (w: string) => planner.seasonOf(new Date(`${w}T12:00:00`));
    const randomSeasons = () => (chance(0.1) ? [] : shuffle(SEASONS).slice(0, int(1, 4)));
    const randomExclude = () => (chance(0.4) ? [] : shuffle([...DISH_TYPES]).slice(0, int(1, 4)));

    // ---------- Expected grocery list (the libraries' own rules, plus independent checks) ----------
    function expectedLines(items: WPR[]) {
      return shopping
        .buildShoppingList(
          items
            .filter((it) => !it.already_bought)
            .map((it) => ({ it, r: recipeById.get(it.recipe_id) }))
            .filter((x) => !!x.r)
            .map(({ it, r }) => ({ title: r!.title, factor: it.multiplier || 1, ingredients: ingByRecipe.get(r!.id) ?? [] })),
          catById as never,
        )
        .filter((l) => l.aisle !== NO_AISLE);
    }

    async function genList(w: string) {
      const pg = await pageOf(w);
      const planId = planIds.get(w);
      if (!planId) return false;
      const prev = listSnap.get(planId) ?? [];
      const lines = expectedLines(pg.items);
      const label = (l: (typeof lines)[number]) => (l.optional ? `${l.label} (facultatif)` : l.label);
      // Only ticked generated lines carry their tick over (a ticked manual item never ticks a generated line).
      const ticked = new Set(prev.filter((p) => p.checked && !p.manual).map((p) => p.ingredient_id ?? `label:${p.label}`));
      const tickedManual = new Set(prev.filter((p) => p.checked && p.manual).map((p) => p.ingredient_id ?? `label:${p.label}`));
      const n = await lib.generateList(planId, pg.items, recipes, ingredients, catalog);
      bump("generateList");
      if (n !== lines.length) fail(`generateList returned ${n}, expected ${lines.length}`);
      const newRows: ListRow[] = lines.map((l, position) => ({
        id: "",
        plan_id: planId,
        ingredient_id: l.ingredientId,
        label: label(l),
        quantity_text: l.quantityText,
        aisle: l.aisle,
        pantry: l.pantry,
        manual: false,
        checked: ticked.has(l.ingredientId ?? `label:${label(l)}`),
        position,
      }));
      for (const r of newRows) {
        const k = r.ingredient_id ?? `label:${r.label}`;
        if (!ticked.has(k) && tickedManual.has(k)) bump("manualTickNotCarried(non-trivial)");
      }
      // A ticked line whose label changed only by "(facultatif)" loses its tick (null-ingredient lines only).
      for (const p of prev.filter((x) => x.checked && !x.manual && !x.ingredient_id)) {
        const base = p.label.replace(/ \(facultatif\)$/, "");
        const again = newRows.find((r) => !r.ingredient_id && r.label.replace(/ \(facultatif\)$/, "") === base);
        if (again && !again.checked) note("tick lost: line without catalogue article changed optional ↔ required");
      }
      listSnap.set(planId, [...prev.filter((r) => r.manual), ...newRows]);
      const sigWanted = hasMakeList ? lib.listSignature(newRows.map((r) => ({ label: r.label, quantity_text: r.quantity_text ?? "" }))) : null;
      if (hasMakeList) madeFrom.set(planId, newRows.map((r) => `${r.label}|${r.quantity_text ?? ""}`).sort());

      // Independent: no line comes only from recipes whose ingredients were already bought.
      const nonBought = pg.items.filter((i) => !i.already_bought);
      const bought = pg.items.filter((i) => i.already_bought);
      const allowed = new Set<string>();
      const allowedNames = new Set<string>();
      for (const it of nonBought)
        for (const ing of ingByRecipe.get(it.recipe_id) ?? []) {
          if (ing.ingredient_id) {
            allowed.add(ing.ingredient_id);
            if (juiceOf.has(ing.ingredient_id)) allowed.add(juiceOf.get(ing.ingredient_id)!);
          } else allowedNames.add(nameKey(ing.name));
        }
      const exclusive = new Set<string>();
      for (const it of bought)
        for (const ing of ingByRecipe.get(it.recipe_id) ?? [])
          if (ing.ingredient_id && !allowed.has(ing.ingredient_id) && catById.get(ing.ingredient_id)?.aisle !== NO_AISLE) exclusive.add(ing.ingredient_id);
      if (exclusive.size) bump("boughtExclusionChecks(non-trivial)");
      await verify((plans) => {
        const plan = plans.find((p) => p.id === planId)!;
        if (hasMakeList) {
          bump("listSignatureChecks");
          if (plan.list_signature !== sigWanted) fail(`list_signature ${String(plan.list_signature)} ≠ ${sigWanted}`);
        } else if (plan.list_signature !== undefined) fail("week_plans.list_signature exists but make_list does not");
        const rows = plan.shopping_items.filter((r) => !r.manual);
        for (const r of rows) {
          if (r.ingredient_id && !allowed.has(r.ingredient_id)) fail(`list line "${r.label}" comes from no recipe still to buy (bought: ${bought.map((b) => b.recipe_id.slice(0, 8)).join(",")})`);
          if (!r.ingredient_id && !allowedNames.has(nameKey(r.label.replace(/ \(facultatif\)$/, "")))) fail(`list line without article "${r.label}" comes from no recipe still to buy`);
          if (r.ingredient_id && exclusive.has(r.ingredient_id)) fail(`line "${r.label}" only an already-bought recipe needs`);
        }
      });
      await checkListStatus(w);
      return true;
    }

    // ---------- RLS: one visitor against the other's rows ----------
    let rlsProbes = 0;
    async function rlsBattery(attacker: SupabaseClient, attackerUser: string, attackerHousehold: string, victimHousehold: string, victim: SupabaseClient) {
      curType = "rls";
      const vPlans = await readAll(victim, victimHousehold);
      const vSnap = snapshot(vPlans);
      const plan = vPlans[0];
      const pid = (plan?.id as string) ?? "00000000-0000-0000-0000-000000000000";
      const wpr = plan?.week_plan_recipes[0]?.id ?? "00000000-0000-0000-0000-000000000000";
      const item = vPlans.flatMap((p) => p.shopping_items)[0]?.id ?? "00000000-0000-0000-0000-000000000000";
      const probe = async (name: string, fn: () => PromiseLike<{ data: unknown; error: unknown }>, expect: "empty" | "error" | "ok" | "any") => {
        rlsProbes++;
        bump(`rls:${name}`);
        let r = await fn();
        if (r.error && isNetwork(r.error)) {
          flaky.push({ op: opNo, type: `rls:${name}`, message: JSON.stringify(r.error) });
          r = await fn();
        }
        const empty = !r.error && (r.data === null || (Array.isArray(r.data) && r.data.length === 0));
        if (expect === "empty" && !(empty || r.error)) fail(`RLS ${name}: returned ${JSON.stringify(r.data).slice(0, 200)}`);
        if (expect === "error" && !r.error) fail(`RLS ${name}: accepted (${JSON.stringify(r.data).slice(0, 200)})`);
        if (expect === "ok" && r.error) fail(`${name}: ${JSON.stringify(r.error)}`);
        return r;
      };
      await probe("read plans", () => attacker.from("week_plans").select("*").eq("household_id", victimHousehold), "empty");
      await probe("read plan by id", () => attacker.from("week_plans").select("*").eq("id", pid), "empty");
      await probe("read plan recipes", () => attacker.from("week_plan_recipes").select("*").eq("plan_id", pid), "empty");
      await probe("read list", () => attacker.from("shopping_items").select("*").eq("plan_id", pid), "empty");
      await probe("read list by id", () => attacker.from("shopping_items").select("*").eq("id", item), "empty");
      await probe("read household", () => attacker.from("households").select("*").eq("id", victimHousehold), "empty");
      await probe("read members", () => attacker.from("household_members").select("*").eq("household_id", victimHousehold), "empty");
      await probe("update plan", () => attacker.from("week_plans").update({ portions: 77, suppers: 9 }).eq("id", pid).select(), "empty");
      await probe("update plan recipe", () => attacker.from("week_plan_recipes").update({ multiplier: 9, already_bought: true }).eq("id", wpr).select(), "empty");
      await probe("update list item", () => attacker.from("shopping_items").update({ checked: true, label: "PIRATE" }).eq("id", item).select(), "empty");
      await probe("delete list item", () => attacker.from("shopping_items").delete().eq("id", item).select(), "empty");
      await probe("delete list of plan", () => attacker.from("shopping_items").delete().eq("plan_id", pid).select(), "empty");
      await probe("delete plan recipe", () => attacker.from("week_plan_recipes").delete().eq("plan_id", pid).select(), "empty");
      await probe("delete plan", () => attacker.from("week_plans").delete().eq("id", pid).select(), "empty");
      await probe("delete plans of household", () => attacker.from("week_plans").delete().eq("household_id", victimHousehold).select(), "empty");
      await probe("insert plan into victim", () => attacker.from("week_plans").insert({ household_id: victimHousehold, week_start: "2031-01-06" }).select(), "error");
      await probe("upsert victim's week", () => attacker.from("week_plans").upsert({ household_id: victimHousehold, week_start: THIS, suppers: 9, portions: 77 }, { onConflict: "household_id,week_start" }).select(), "error");
      await probe("insert recipe into victim plan", () => attacker.from("week_plan_recipes").insert({ plan_id: pid, recipe_id: pool[0], portions: 4, position: 99 }).select(), "error");
      await probe("insert item into victim list", () => attacker.from("shopping_items").insert({ plan_id: pid, label: "PIRATE", aisle: "autre", manual: true }).select(), "error");
      // Moving one's own rows into the victim's household / plan.
      const own = (must(await attacker.from("week_plans").select("id, week_plan_recipes(id), shopping_items(id)").eq("household_id", attackerHousehold), "own") as { id: string; week_plan_recipes: { id: string }[]; shopping_items: { id: string }[] }[])[0];
      if (own) {
        await probe("move own plan to victim", () => attacker.from("week_plans").update({ household_id: victimHousehold }).eq("id", own.id).select(), "error");
        if (own.week_plan_recipes[0]) await probe("move own plan recipe to victim plan", () => attacker.from("week_plan_recipes").update({ plan_id: pid }).eq("id", own.week_plan_recipes[0].id).select(), "error");
        if (own.shopping_items[0]) await probe("move own item to victim list", () => attacker.from("shopping_items").update({ plan_id: pid }).eq("id", own.shopping_items[0].id).select(), "error");
      }
      await probe("read usage_days", () => attacker.from("usage_days").select("*"), "empty");
      await probe("insert usage_days (own)", () => attacker.from("usage_days").insert({ household_id: attackerHousehold, user_id: attackerUser, day: "2030-01-01" }).select(), "error");
      await probe("insert usage_days (victim)", () => attacker.from("usage_days").insert({ household_id: victimHousehold, user_id: attackerUser, day: "2030-01-01" }).select(), "error");
      await probe("update usage_days", () => attacker.from("usage_days").update({ opens: 999 }).eq("household_id", victimHousehold).select(), "empty");
      await probe("delete usage_days", () => attacker.from("usage_days").delete().eq("household_id", victimHousehold).select(), "empty");
      await probe("usage_summary() refused", () => attacker.rpc("usage_summary"), "error");
      await probe("usage_stats() refused", () => attacker.rpc("usage_stats"), "error");
      await probe("log_usage() with a household argument refused", () => attacker.rpc("log_usage", { household_id: victimHousehold }), "error");
      // Migration 0015's functions run with the caller's rights: the victim's household and plans stay out of reach.
      const week = (ws: string, ids: string[]) => ({
        week_start: ws,
        suppers: 9,
        portions: 77,
        seasons: ["hiver"],
        exclude_dish_types: [],
        recipes: ids.map((id, position) => ({ recipe_id: id, position, multiplier: 3, portions: 3 * sv(id), postponed: true, already_bought: true })),
      });
      const vWeek = (plan?.week_start as string) ?? THIS;
      await probe("save_weeks on victim's existing week", () => attacker.rpc("save_weeks", { p_household: victimHousehold, p_weeks: [week(vWeek, pool.slice(3, 5))] }), "error");
      await probe("save_weeks on victim's existing week, no recipes", () => attacker.rpc("save_weeks", { p_household: victimHousehold, p_weeks: [week(vWeek, [])] }), "error");
      await probe("save_weeks new week in victim", () => attacker.rpc("save_weeks", { p_household: victimHousehold, p_weeks: [week("2031-09-01", pool.slice(3, 4))] }), "error");
      await probe("save_weeks own week then victim's", () => attacker.rpc("save_weeks", { p_household: victimHousehold, p_weeks: [week("2031-09-08", []), week(vWeek, pool.slice(3, 4))] }), "error");
      await probe("save_weeks victim, empty list of weeks", () => attacker.rpc("save_weeks", { p_household: victimHousehold, p_weeks: [] }), "empty");
      const row = { ingredient_id: null, label: "PIRATE", quantity_text: "1", aisle: "autre", pantry: false, position: 0 };
      await probe("replace_list on victim's plan", () => attacker.rpc("replace_list", { p_plan: pid, p_rows: [row] }), "error");
      await probe("replace_list on victim's plan, catalogue line", () => attacker.rpc("replace_list", { p_plan: pid, p_rows: [{ ...row, ingredient_id: catalog[0]?.id ?? null }] }), "error");
      if (hasMakeList) {
        await probe("make_list on victim's plan", () => attacker.rpc("make_list", { p_plan: pid, p_rows: [row], p_signature: "PIRATE" }), "error");
        await probe("make_list on victim's plan, no rows", () => attacker.rpc("make_list", { p_plan: pid, p_rows: [], p_signature: "PIRATE" }), "error");
      }
      // No rows: nothing to insert, so no error can come from the insert; the victim's lines must still be untouched.
      const noRows = await probe("replace_list on victim's plan, no rows (delete only)", () => attacker.rpc("replace_list", { p_plan: pid, p_rows: [] }), "any");
      if (!noRows.error && noRows.data !== 0) fail(`replace_list on victim's plan with no rows returned ${JSON.stringify(noRows.data)}`);
      const after = await readAll(victim, victimHousehold);
      if (snapshot(after) !== vSnap) fail(`victim household ${victimHousehold} changed during the RLS probes`);
      if (!after.some((p) => p.shopping_items.some((s) => !s.manual))) note("RLS: victim had no generated list line during the probes");
      bump("rlsBattery");
    }

    // ---------- Setup checks ----------
    curType = "setup";
    // Migration 0016 (make_list + week_plans.list_signature) may or may not be applied: probe with a plan that does not exist.
    {
      const r = await sbA.rpc("make_list", { p_plan: "00000000-0000-0000-0000-000000000000", p_rows: [], p_signature: "audit" });
      hasMakeList = r.error?.code !== "PGRST202";
      console.log(`make_list (0016): ${hasMakeList ? `present (unknown plan → ${r.error ? `${r.error.code} ${r.error.message}` : "accepted!"})` : "absent (PGRST202): the library must fall back to replace_list"}`);
      if (hasMakeList && !r.error) fail("make_list accepted a plan that does not exist");
      const c = await sbA.from("week_plans").select("list_signature").limit(1);
      if (!!c.error === hasMakeList) note(`make_list ${hasMakeList ? "present" : "absent"} but list_signature column ${c.error ? "absent" : "present"}`);
    }
    listRpc = hasMakeList ? "make_list" : "replace_list";
    for (const [sb, who] of [[sbA, "A"], [sbB, "B"]] as const) {
      const r = await sb.rpc("log_usage");
      bump("log_usage");
      if (r.error) fail(`log_usage() as ${who}: ${JSON.stringify(r.error)}`);
      for (const fn of ["usage_summary", "usage_stats"]) {
        const s = await sb.rpc(fn);
        bump(`${fn} (non-book)`);
        if (!s.error) fail(`${fn}() answered a non-book household ${who}: ${JSON.stringify(s.data).slice(0, 200)}`);
        else if (!/réservé au livre/.test(s.error.message)) note(`${fn} refused with another message: ${s.error.message}`);
      }
    }
    // B: one plan with a recipe and a list item, for the reverse probes.
    {
      const p = must(await sbB.from("week_plans").upsert({ household_id: H2, week_start: THIS, suppers: 2, portions: 8, seasons: ["automne"], exclude_dish_types: [] }, { onConflict: "household_id,week_start" }).select("id").single(), "B plan") as { id: string };
      must(await sbB.from("week_plan_recipes").insert([{ plan_id: p.id, recipe_id: pool[1], position: 0, multiplier: 1, portions: sv(pool[1]), postponed: true }, { plan_id: p.id, recipe_id: pool[2], position: 1, multiplier: 2, portions: 2 * sv(pool[2]) }], { defaultToNull: false }), "B recipes");
      must(await sbB.from("shopping_items").insert({ plan_id: p.id, label: "TEST B", aisle: "autre", manual: true }), "B item");
      must(await sbB.from("shopping_items").insert({ plan_id: p.id, label: "TEST B généré", quantity_text: "2", aisle: "autre", manual: false, checked: true, position: 0 }), "B generated line");
    }
    // Flags insert: with { defaultToNull: false } a row without the key gets the column default; without it, null is sent.
    {
      curType = "flags-insert";
      const p = must(await sbA.from("week_plans").upsert({ household_id: H1, week_start: "2031-03-03", suppers: 2, portions: 8, seasons: [], exclude_dish_types: [] }, { onConflict: "household_id,week_start" }).select("id").single(), "scratch plan") as { id: string };
      const rows = [{ plan_id: p.id, recipe_id: pool[0], position: 0, multiplier: 1, portions: 4, postponed: true }, { plan_id: p.id, recipe_id: pool[1], position: 1, multiplier: 1, portions: 4 }];
      const ok = await sbA.from("week_plan_recipes").insert(rows, { defaultToNull: false }).select("recipe_id,postponed,already_bought");
      bump("flagsInsert(defaultToNull:false)");
      if (ok.error) fail(`insert with defaultToNull:false: ${JSON.stringify(ok.error)}`);
      else {
        const d = ok.data as { recipe_id: string; postponed: boolean; already_bought: boolean }[];
        const second = d.find((x) => x.recipe_id === pool[1]);
        if (!second || second.postponed !== false || second.already_bought !== false) fail(`row without flags got ${JSON.stringify(second)}`);
        if (d.find((x) => x.recipe_id === pool[0])?.postponed !== true) fail("postponed not written");
      }
      must(await sbA.from("week_plan_recipes").delete().eq("plan_id", p.id), "clear scratch");
      const bad = await sbA.from("week_plan_recipes").insert(rows).select("recipe_id");
      bump("flagsInsert(default)");
      console.log(`INFO  same mixed insert without defaultToNull:false → ${bad.error ? `refused (${bad.error.code} ${bad.error.message.slice(0, 80)})` : "accepted"}`);
      must(await sbA.from("week_plans").delete().eq("id", p.id), "delete scratch");
      // Unique (household_id, week_start): a second plan for the same week is refused.
      must(await sbA.from("week_plans").upsert({ household_id: H1, week_start: THIS, suppers: 5, portions: 20, seasons: ["automne"], exclude_dish_types: [] }, { onConflict: "household_id,week_start" }), "this week plan");
      expected.set(THIS, { suppers: 5, portions: 20, seasons: ["automne"], exclude: [], items: [] });
      for (let i = 0; i < 3; i++) {
        const dup = await sbA.from("week_plans").insert({ household_id: H1, week_start: THIS, suppers: 1 }).select();
        bump("uniqueWeekInsert");
        if (!dup.error) fail(`duplicate (household, ${THIS}) accepted`);
        else if (dup.error.code !== "23505") note(`duplicate refused with ${dup.error.code}`);
      }
      await verify();
    }

    // ---------- Random operations ----------
    const TYPES = ["rawSave", "suggest", "changeSettings", "swap", "settingsOnly", "remove", "add", "multiplier", "postpone", "setBought", "generateList", "tick", "manualAdd", "manualRemove", "clearChecked", "loadWeek", "listOrder"] as const;
    type T = (typeof TYPES)[number];
    const done = new Map<T, number>(TYPES.map((t) => [t, 0]));
    doneCounts = done;
    const deadline = t0 + MAX_MINUTES * 60_000;
    let manualN = 0;
    let opWeek = THIS;

    const listRowsOf = (w: string) => listSnap.get(planIds.get(w) ?? "") ?? [];

    async function run(type: T): Promise<boolean> {
      // A week where the operation is possible (this or next week mostly, the past week now and then).
      const usable = (wk: string) => {
        const e = expected.get(wk);
        const rows = listRowsOf(wk);
        if (["remove", "multiplier", "setBought", "swap"].includes(type)) return !!e?.items.length;
        if (["settingsOnly", "generateList", "manualAdd"].includes(type)) return !!e;
        if (type === "tick") return rows.length > 0;
        if (type === "manualRemove") return rows.length > 0;
        if (type === "clearChecked") return rows.some((r) => r.checked);
        return true;
      };
      const candidates = (chance(0.15) ? [PAST, THIS, NEXT] : [THIS, NEXT]).filter(usable);
      const w = type === "postpone" ? THIS : candidates.length ? pick(candidates) : pick([THIS, NEXT]);
      opWeek = w;
      switch (type) {
        case "rawSave": {
          // A week written directly (another phone, an older page): postponed recipes kept as they are, others random.
          const pg = await pageOf(w);
          const s: WeekSettings = {
            portions: Math.max(1, Math.min(80, pg.settings.portions + pick([-6, -4, -2, -1, 1, 2, 4, 6, 10]))),
            recipes: Math.max(1, Math.min(10, pg.settings.recipes + pick([-2, -1, 0, 1, 2]))),
            seasons: chance(0.5) ? randomSeasons() : pg.settings.seasons,
            excludeDishTypes: chance(0.5) ? randomExclude() : pg.settings.excludeDishTypes,
          };
          const keep = pg.items.filter((i) => i.postponed).map((i) => i.recipe_id);
          const n = Math.max(keep.length, int(chance(0.05) ? 0 : 1, s.recipes));
          const others = shuffle(pool.filter((id) => !keep.includes(id))).slice(0, Math.max(0, n - keep.length));
          const ids = [...keep, ...others];
          const planned = chance(0.5) ? refit(ids, s.portions, pg.items) : ids.map((id) => ({ id, multiplier: lib.fixedOf(pg.items).get(id) ?? int(1, 3) }));
          opLog.push(`#${opNo} rawSave ${w} portions=${s.portions} recipes=${s.recipes} seasons=${s.seasons} excl=${s.excludeDishTypes} planned=${planned.map((p) => `${p.id.slice(0, 8)}×${p.multiplier}`).join(",")}`);
          checkFixedKept(w, pg.items, planned, "rawSave");
          await persist(w, planned, s);
          return true;
        }
        case "suggest": {
          // suggestAll(): postponed recipes stay with their multiplier, the planner fills the rest.
          const pg = await pageOf(w);
          const fixedList = [...lib.fixedOf(pg.items)].map(([id, multiplier]) => ({ id, multiplier }));
          const s = { ...pg.settings, recipes: Math.max(pg.settings.recipes, fixedList.length, 1) };
          const plan = planner.planWeek(await plannerFor(w), s.recipes, s.portions, rules, season(w), { fixed: fixedList, random: rnd, filters: { seasons: s.seasons, excludeDishTypes: s.excludeDishTypes } });
          opLog.push(`#${opNo} suggest ${w} portions=${s.portions} recipes=${s.recipes} fixed=${fixedList.map((p) => `${p.id.slice(0, 8)}×${p.multiplier}`).join(",")} → ${plan.map((p) => `${p.id.slice(0, 8)}×${p.multiplier}`).join(",")}`);
          if (!plan.length) {
            bump("suggest(empty: no recipe matches)");
            return true;
          }
          if (plan.length > s.recipes) fail(`suggest ${w}: ${plan.length} recipes > ${s.recipes}`);
          checkFixedKept(w, pg.items, plan, "suggest");
          await persist(w, plan, s, flagsFrom(pg.items));
          return true;
        }
        case "changeSettings": {
          // The portions or recipes steppers (recipes never below the postponed ones), like changeSettings().
          const pg = await pageOf(w);
          const cur = currentOf(pg);
          const fixed = lib.fixedOf(pg.items);
          const fixedList = [...fixed].map(([id, multiplier]) => ({ id, multiplier }));
          const byPortions = chance(0.5);
          const s: WeekSettings = byPortions
            ? { ...pg.settings, portions: Math.max(1, Math.min(80, pg.settings.portions + pick([-6, -4, -2, -1, 1, 2, 4, 6, 10]))) }
            : { ...pg.settings, recipes: Math.max(1, fixed.size, Math.min(10, pg.settings.recipes + pick([-2, -1, 1, 2]))) };
          if (s.portions === pg.settings.portions && s.recipes === pg.settings.recipes) return false;
          opLog.push(`#${opNo} changeSettings ${w} portions ${pg.settings.portions}→${s.portions} recipes ${pg.settings.recipes}→${s.recipes} fixed=${fixedList.map((p) => `${p.id.slice(0, 8)}×${p.multiplier}`).join(",")}`);
          if (!cur.length) {
            page.set(w, { ...pg, settings: s }); // the page only remembers it until the next save
            return true;
          }
          const plan = planner.planWeek(await plannerFor(w), s.recipes, s.portions, rules, season(w), {
            keep: cur.map((p) => p.id),
            fixed: fixedList,
            random: rnd,
            filters: { seasons: s.seasons, excludeDishTypes: s.excludeDishTypes },
          });
          const planned = plan.length ? plan : refit(cur.map((p) => p.id), s.portions, pg.items);
          if (!plan.length) bump("changeSettings(refit fallback)");
          checkFixedKept(w, pg.items, planned, "changeSettings");
          await persist(w, planned, s);
          return true;
        }
        case "swap": {
          const pg = await pageOf(w);
          if (!pg.items.length) return false;
          const it = pick(pg.items);
          const filters = { seasons: pg.settings.seasons, excludeDishTypes: pg.settings.excludeDishTypes };
          const next = planner.swapInPlan(await plannerFor(w), currentOf(pg), it.recipe_id, pg.settings.portions, rules, season(w), { filters, fixed: lib.fixedOf(pg.items), random: rnd });
          opLog.push(`#${opNo} swap ${w} ${it.recipe_id.slice(0, 8)}${it.postponed ? "(postponed)" : ""} → ${next?.map((p) => `${p.id.slice(0, 8)}×${p.multiplier}`).join(",") ?? "none"}`);
          if (!next) {
            bump("swap(none fits)");
            return true;
          }
          if (next.some((p) => p.id === it.recipe_id)) fail(`swap ${w}: ${it.recipe_id.slice(0, 8)} still in the week`);
          if (it.postponed) bump("swap(postponed itself)");
          checkFixedKept(w, pg.items, next, "swap", it.recipe_id);
          // The replacement takes the swapped recipe's place: its marks are not carried over (flagsOf of the others).
          const flags = flagsFrom(pg.items);
          await persist(w, next, pg.settings, flags);
          return true;
        }
        case "settingsOnly": {
          if (!expected.has(w)) return false;
          const pg = await pageOf(w);
          const s = { ...pg.settings, seasons: randomSeasons(), excludeDishTypes: randomExclude() };
          opLog.push(`#${opNo} settingsOnly ${w} seasons=${s.seasons} excl=${s.excludeDishTypes}`);
          await persist(w, currentOf(pg), s);
          return true;
        }
        case "remove": {
          const pg = await pageOf(w);
          if (!pg.items.length) return false;
          const it = pick(pg.items);
          const id = it.recipe_id;
          opLog.push(`#${opNo} remove ${w} ${id.slice(0, 8)}${it.postponed ? "(postponed)" : ""}`);
          const planned = refit(currentOf(pg).filter((p) => p.id !== id).map((p) => p.id), pg.settings.portions, pg.items);
          checkFixedKept(w, pg.items, planned, "remove", id);
          await persist(w, planned, pg.settings);
          return true;
        }
        case "add": {
          const pg = await pageOf(w);
          const cur = currentOf(pg);
          if (cur.length >= 10) return false;
          const id = pick(pool.filter((x) => !cur.some((p) => p.id === x)));
          const ids = [...cur.map((p) => p.id), id];
          const s = { ...pg.settings, recipes: Math.max(pg.settings.recipes, ids.length) };
          opLog.push(`#${opNo} add ${w} ${id.slice(0, 8)}`);
          const planned = refit(ids, s.portions, pg.items);
          checkFixedKept(w, pg.items, planned, "add");
          await persist(w, planned, s);
          return true;
        }
        case "multiplier": {
          const pg = await pageOf(w);
          if (!pg.items.length) return false;
          const it = pick(pg.items);
          const m = Math.max(1, Math.min(6, (it.multiplier || 1) + pick([-1, 1])));
          opLog.push(`#${opNo} multiplier ${w} ${it.recipe_id.slice(0, 8)}${it.postponed ? "(postponed)" : ""} → ${m}`);
          const planned = currentOf(pg).map((p) => (p.id === it.recipe_id ? { ...p, multiplier: m } : p));
          checkFixedKept(w, pg.items, planned, "multiplier", it.recipe_id);
          await persist(w, planned, pg.settings);
          return true;
        }
        case "postpone": {
          const pg = await pageOf(THIS);
          if (!pg.items.length) return false;
          const moved = pick(currentOf(pg));
          const bought = chance(0.5);
          const nextExp = expected.get(NEXT);
          const already = !!nextExp?.items.some((i) => i.recipe_id === moved.id);
          opLog.push(`#${opNo} postpone ${moved.id.slice(0, 8)}×${moved.multiplier} bought=${bought} (already=${already})`);
          const fromFlags = flagsFrom(pg.items);
          const res = await lib.postponeRecipe(H1, { week: THIS, settings: pg.settings, planned: currentOf(pg), flags: fromFlags }, moved.id, bought, pg.settings, sv);
          bump(`postpone:${res === "already" ? "already" : "ok"}`);
          if ((res === "already") !== already) fail(`postponeRecipe returned ${res === "already" ? "already" : "ok"}, expected ${already ? "already" : "ok"}`);
          if (res === "already") return true;
          const base = nextExp
            ? { suppers: nextExp.suppers, portions: nextExp.portions, seasons: nextExp.seasons, exclude: nextExp.exclude }
            : { suppers: pg.settings.recipes, portions: pg.settings.portions, seasons: [planner.seasonOf(new Date(`${NEXT}T12:00:00`))], exclude: pg.settings.excludeDishTypes };
          if (!nextExp) bump("postpone:createdNextPlan");
          const items = [...(nextExp?.items ?? []), { recipe_id: moved.id, multiplier: moved.multiplier, postponed: true, already_bought: bought }];
          expected.set(NEXT, { ...base, suppers: Math.max(base.suppers, items.length), items });
          // This week: without it, the others untouched (no multiplier changed to make up for it), their marks kept.
          const rest = currentOf(pg).filter((p) => p.id !== moved.id);
          fromFlags.delete(moved.id);
          expected.set(THIS, { ...expected.get(THIS)!, items: expFromPlanned(rest, fromFlags) });
          checkSaved(THIS, res.from, pg.settings, rest, fromFlags, "postponeRecipe(from)");
          const nextFlags = new Map(items.map((i) => [i.recipe_id, i]));
          checkSaved(NEXT, res.next, { portions: base.portions, recipes: Math.max(base.suppers, items.length), seasons: base.seasons, excludeDishTypes: base.exclude }, items.map((i) => ({ id: i.recipe_id, multiplier: i.multiplier })), nextFlags, "postponeRecipe(next)");
          page.set(THIS, { settings: pg.settings, items: res.from.items });
          page.set(NEXT, null); // the page is on this week; next week is loaded when opened
          return true;
        }
        case "setBought": {
          const pg = await pageOf(w);
          const postponed = pg.items.filter((i) => i.postponed);
          // The page offers it on postponed recipes only; now and then also on another recipe.
          const it = postponed.length && chance(0.9) ? pick(postponed) : pg.items.length ? pick(pg.items) : null;
          if (!it) return false;
          const b = !it.already_bought;
          if (!it.postponed) bump("setBought(non-postponed)");
          opLog.push(`#${opNo} setBought ${w} ${it.recipe_id.slice(0, 8)} → ${b}`);
          const flags = flagsFrom(pg.items);
          flags.set(it.recipe_id, { ...flags.get(it.recipe_id), already_bought: b } as never);
          checkFixedKept(w, pg.items, currentOf(pg), "setBought");
          await persist(w, currentOf(pg), pg.settings, flags);
          return true;
        }
        case "generateList": {
          if (!expected.has(w)) return false;
          opLog.push(`#${opNo} generateList ${w} (items ${(page.get(w)?.items ?? []).map((i) => `${i.recipe_id.slice(0, 8)}${i.already_bought ? "B" : ""}`).join(",")})`);
          return genList(w);
        }
        case "tick": {
          const rows = listRowsOf(w);
          if (!rows.length) return false;
          const r = pick(rows);
          opLog.push(`#${opNo} tick ${w} "${r.label}" → ${!r.checked}`);
          must(await sbA.from("shopping_items").update({ checked: !r.checked }).eq("id", r.id), "tick");
          listSnap.set(r.plan_id, rows.map((x) => (x.id === r.id ? { ...x, checked: !r.checked } : x)));
          return true;
        }
        case "manualAdd": {
          const planId = planIds.get(w);
          if (!planId) return false;
          // Half the time a manual item that looks like a generated line (same article or label), ticked: it must
          // never tick that line when the list is made again.
          const generated = listRowsOf(w).filter((r) => !r.manual);
          const twin = generated.length && chance(0.5) ? pick(generated) : null;
          const label = twin ? twin.label : `TEST manuel ${++manualN}`;
          const checked = twin ? true : chance(0.3);
          opLog.push(`#${opNo} manualAdd ${w} "${label}"${twin ? ` twin of a generated line (${twin.ingredient_id ?? "no article"})` : ""} checked=${checked}`);
          if (twin) bump("manualAdd(twin of a generated line, ticked)");
          const d = must(
            await sbA.from("shopping_items").insert({ plan_id: planId, label, ingredient_id: twin?.ingredient_id ?? null, aisle: twin?.aisle ?? "autre", manual: true, checked, position: 9999 }).select("*").single(),
            "manual add",
          ) as ListRow;
          listSnap.set(planId, [...listRowsOf(w), d]);
          return true;
        }
        case "manualRemove": {
          const rows = listRowsOf(w);
          const manual = rows.filter((r) => r.manual);
          const r = manual.length && chance(0.8) ? pick(manual) : rows.length ? pick(rows) : null;
          if (!r) return false;
          opLog.push(`#${opNo} remove item ${w} "${r.label}"`);
          must(await sbA.from("shopping_items").delete().eq("id", r.id), "remove item");
          listSnap.set(r.plan_id, rows.filter((x) => x.id !== r.id));
          return true;
        }
        case "clearChecked": {
          const rows = listRowsOf(w);
          const ids = rows.filter((r) => r.checked).map((r) => r.id);
          if (!ids.length) return false;
          opLog.push(`#${opNo} clearChecked ${w} (${ids.length})`);
          must(await sbA.from("shopping_items").delete().in("id", ids), "clear checked");
          listSnap.set(planIds.get(w)!, rows.filter((r) => !r.checked));
          return true;
        }
        case "loadWeek": {
          opLog.push(`#${opNo} loadWeek ${w}`);
          const r = await openWeek(w);
          const exp = expected.get(w);
          if (!exp && r.items.length) fail(`loadWeek ${w}: items for a week without plan`);
          if (exp && (r.settings.portions !== exp.portions || r.settings.recipes !== exp.suppers)) fail(`loadWeek ${w} settings ${r.settings.portions}/${r.settings.recipes}`);
          return true;
        }
        case "listOrder": {
          // The list page's choice: requested plan, else this week, upcoming (soonest first), then past (latest first); first with items.
          const plans = must(await sbA.from("week_plans").select("id, week_start").eq("household_id", H1).order("week_start", { ascending: false }).limit(6), "plans") as { id: string; week_start: string }[];
          const requested = chance(0.3) ? null : (pick(plans)?.id ?? null);
          const ordered = lib.listOrder(plans, requested, THIS);
          let chosen: string | null = null;
          for (const p of ordered) {
            const d = must(await sbA.from("shopping_items").select("id").eq("plan_id", p.id).limit(1), "items") as unknown[];
            if (d.length) {
              chosen = p.id;
              break;
            }
          }
          chosen ??= ordered[0]?.id ?? null;
          const has = (id: string) => (listSnap.get(id) ?? []).length > 0;
          const byWeek = (wk: string) => plans.find((p) => p.week_start === wk);
          const future = plans.filter((p) => p.week_start > THIS).sort((a, b) => a.week_start.localeCompare(b.week_start));
          const past = plans.filter((p) => p.week_start < THIS).sort((a, b) => b.week_start.localeCompare(a.week_start));
          const order = [...(requested ? [plans.find((p) => p.id === requested)!] : []), ...[byWeek(THIS), ...future, ...past].filter((p) => p && p.id !== requested)] as { id: string; week_start: string }[];
          const want = order.find((p) => has(p.id))?.id ?? order[0]?.id ?? null;
          opLog.push(`#${opNo} listOrder requested=${plans.find((p) => p.id === requested)?.week_start ?? null} → ${plans.find((p) => p.id === chosen)?.week_start}`);
          if (chosen !== want) fail(`list page picks ${plans.find((p) => p.id === chosen)?.week_start}, expected ${plans.find((p) => p.id === want)?.week_start} (requested ${plans.find((p) => p.id === requested)?.week_start ?? "none"})`);
          return true;
        }
      }
    }

    let sinceRls = 0;
    while (opNo < MAX_OPS && Date.now() < deadline) {
      // Least-run types first (weighted), so every type gets its share.
      const min = Math.min(...done.values());
      const weights = TYPES.map((t) => 1 / (1 + done.get(t)! - min) ** 2);
      let x = rnd() * weights.reduce((a, b) => a + b, 0);
      let type: T = TYPES[0];
      for (let i = 0; i < TYPES.length; i++) if ((x -= weights[i]) <= 0) {
        type = TYPES[i];
        break;
      }
      opNo++;
      curType = type;
      try {
        const ran = await run(type);
        if (!ran) {
          opNo--;
          // Not possible now (empty week…): make it possible next time.
          const pre: T = type === "clearChecked" ? "tick" : type === "tick" || type === "manualRemove" ? "generateList" : "rawSave";
          opNo++;
          curType = pre;
          if (await run(pre)) {
            done.set(pre, done.get(pre)! + 1);
            if (pre !== "generateList") await verify().then(() => checkListStatus(opWeek));
          } else opNo--;
          continue;
        }
        done.set(type, done.get(type)! + 1);
        if (type !== "generateList") {
          await verify();
          await checkListStatus(opWeek);
          if (type === "postpone") await checkListStatus(NEXT);
        }
      } catch (e) {
        if (isNetwork(e)) {
          flaky.push({ op: opNo, type, message: e instanceof Error ? e.message : String(e) });
          console.log(`FLAKY #${opNo} ${type}: ${e instanceof Error ? e.message : e} — resync`);
        } else fail(`threw: ${e instanceof Error ? e.message : JSON.stringify(e)}`);
        // Resync from the database.
        for (const w of WEEKS) page.set(w, null);
        const plans = await readAll(sbA, H1);
        expected.clear();
        for (const p of plans) {
          const items = [...p.week_plan_recipes].sort((a, b) => a.position - b.position);
          expected.set(p.week_start as string, { suppers: p.suppers as number, portions: Number(p.portions), seasons: p.seasons as string[], exclude: p.exclude_dish_types as string[], items: items.map((i) => ({ recipe_id: i.recipe_id, multiplier: i.multiplier, postponed: !!i.postponed, already_bought: !!i.already_bought })) });
        }
        listSnap = new Map(plans.map((p) => [p.id as string, p.shopping_items]));
      }
      if (++sinceRls >= 60) {
        sinceRls = 0;
        await rlsBattery(sbB, userB, H2, H1, sbA);
        await rlsBattery(sbA, userA, H1, H2, sbB);
        await verify();
      }
      if (opNo % 100 === 0) console.log(`… ${opNo} ops, ${failures.length} failures, ${((Date.now() - t0) / 1000).toFixed(0)} s, ${requests} requests`);
    }
    await rlsBattery(sbB, userB, H2, H1, sbA);
    await rlsBattery(sbA, userA, H1, H2, sbB);
    await verify();

    // ---------- Postponing into a week without a plan (fallback settings), in far weeks deleted afterwards ----------
    curType = "postponeFallback";
    for (let k = 0; k < 8; k++) {
      const from = planner.weekStart(new Date(2030, k, 7 + 7 * k));
      const to = lib.nextWeekOf(from);
      const s: WeekSettings = { portions: int(4, 30), recipes: int(1, 6), seasons: randomSeasons(), excludeDishTypes: randomExclude() };
      const ids = shuffle(pool).slice(0, 3);
      const planned = ids.map((id, i) => ({ id, multiplier: i === 1 ? 2 : 1 }));
      const flags = new Map([[ids[0], { postponed: true, already_bought: true }]]);
      await lib.saveWeek(H1, from, s, planned, sv, flags);
      const bought = chance(0.5);
      opLog.push(`postponeFallback ${from}→${to} ${ids[1].slice(0, 8)}×2 bought=${bought}`);
      const res = await lib.postponeRecipe(H1, { week: from, settings: s, planned, flags }, ids[1], bought, s, sv);
      bump("postponeFallback");
      const n = await lib.loadWeek(H1, to);
      const f = await lib.loadWeek(H1, from);
      const season = planner.seasonOf(new Date(`${to}T12:00:00`));
      if (res === "already" || !n.plan) fail(`fallback postpone ${from}→${to}: ${res === "already" ? res : "ok"}, plan ${!!n.plan}`);
      else {
        if (n.plan.portions !== s.portions || n.plan.suppers !== Math.max(s.recipes, 1) || JSON.stringify(n.plan.seasons) !== JSON.stringify([season]) || JSON.stringify(n.plan.exclude_dish_types) !== JSON.stringify(s.excludeDishTypes))
          fail(`fallback plan ${to}: ${JSON.stringify({ p: n.plan.portions, s: n.plan.suppers, se: n.plan.seasons, ex: n.plan.exclude_dish_types })} vs settings ${JSON.stringify(s)} season ${season}`);
        const it = n.items;
        if (it.length !== 1 || it[0].recipe_id !== ids[1] || it[0].multiplier !== 2 || !it[0].postponed || it[0].already_bought !== bought || Number(it[0].portions) !== 2 * sv(ids[1])) fail(`fallback items ${JSON.stringify(it)}`);
        const fs = f.items.map((i) => `${i.recipe_id}×${i.multiplier}${i.postponed ? "P" : ""}${i.already_bought ? "B" : ""}`).join(" ");
        if (fs !== `${ids[0]}×1PB ${ids[2]}×1`) fail(`fallback from-week ${from} left as [${fs}]`);
      }
      must(await sbA.from("week_plans").delete().eq("household_id", H1).in("week_start", [from, to]), "delete far weeks");
    }
    await verify();

    // ---------- Atomicity of migration 0015's functions (far weeks, deleted afterwards) ----------
    // A real failure inside the transaction (constraint violation on the last row sent) must leave everything as it was.
    curType = "atomicity";
    const F = "2031-06-02", F2 = lib.nextWeekOf(F), F3 = lib.nextWeekOf(F2);
    const FAR = [F, F2, F3];
    const bogus = () => crypto.randomUUID();
    const farSnap = async () => snapshot((await readAll(sbA, H1)).filter((p) => FAR.includes(p.week_start as string)));
    const farRows = async (planId: string) => must(await sbA.from("shopping_items").select("*").eq("plan_id", planId), "far rows") as ListRow[];
    const atomicReport: string[] = [];
    const codes = new Map<string, number>();
    const expectRefused = (what: string, err: unknown, code: string) => {
      const raw = (err as { code?: string } | null)?.code ?? (err instanceof Error ? ((err as { code?: string }).code ?? err.message) : String(err));
      const c = raw || `(no code) ${JSON.stringify(err).slice(0, 160)}`;
      codes.set(`${what}: ${c}`, (codes.get(`${what}: ${c}`) ?? 0) + 1);
      if (!err) fail(`${what}: accepted`);
      else if (c !== code) note(`${what} refused with ${c} (expected ${code})`);
    };
    /** A far week with recipes (one postponed + bought), its list made, some generated lines ticked, a manual item. */
    async function farWeek(w: string, n: number) {
      const s: WeekSettings = { portions: int(6, 30), recipes: Math.max(n, int(1, 6)), seasons: randomSeasons(), excludeDishTypes: randomExclude() };
      const ids = shuffle(pool).slice(0, n);
      const planned = ids.map((id) => ({ id, multiplier: int(1, 3) }));
      const flags = new Map(ids.slice(0, 1).map((id) => [id, { postponed: true, already_bought: chance(0.5) }]));
      const saved = await lib.saveWeek(H1, w, s, planned, sv, flags);
      await lib.generateList(saved.plan.id, saved.items, recipes, ingredients, catalog);
      const rows = await farRows(saved.plan.id);
      for (const r of rows.filter(() => chance(0.4))) must(await sbA.from("shopping_items").update({ checked: true }).eq("id", r.id), "tick far");
      must(await sbA.from("shopping_items").insert({ plan_id: saved.plan.id, label: `TEST manuel far ${w}`, aisle: "autre", manual: true, checked: true, position: 9999 }), "far manual");
      return { s, planned, flags, saved };
    }
    const payload = (w: string, s: WeekSettings, planned: { id: string; multiplier: number }[], flags = new Map<string, { postponed?: boolean; already_bought?: boolean }>()) => ({
      week_start: w,
      suppers: s.recipes,
      portions: s.portions,
      seasons: s.seasons,
      exclude_dish_types: s.excludeDishTypes,
      recipes: planned.map((p, position) => ({ recipe_id: p.id, position, multiplier: p.multiplier, portions: p.multiplier * sv(p.id), postponed: !!flags.get(p.id)?.postponed, already_bought: !!flags.get(p.id)?.already_bought })),
    });
    const ITER = Number(arg("atomic") ?? 20);
    for (let k = 0; k < ITER; k++) {
      if (Date.now() > deadline + 150_000) {
        note("atomicity loop cut short by the time limit");
        break;
      }
      must(await sbA.from("week_plans").delete().eq("household_id", H1).in("week_start", FAR), "reset far weeks");
      const a = await farWeek(F, int(2, 5));
      const b = chance(0.8) ? await farWeek(F2, int(1, 4)) : null; // sometimes the second week does not exist yet
      const other = () => shuffle(pool).slice(0, int(1, 4)).map((id) => ({ id, multiplier: int(1, 3) }));
      const changed = (s: WeekSettings): WeekSettings => ({ portions: s.portions + 1, recipes: s.recipes, seasons: ["hiver"], excludeDishTypes: ["soupe"] });
      const withBad = (planned: { id: string; multiplier: number }[]) => {
        const out = [...planned];
        out.splice(int(0, out.length), 0, { id: bogus(), multiplier: 1 });
        return out;
      };

      // A1: save_weeks, first week valid (changed), second week with an unknown recipe id (FK violation).
      {
        const before = await farSnap();
        const r = await sbA.rpc("save_weeks", { p_household: H1, p_weeks: [payload(F, changed(a.s), other()), payload(F2, b?.s ?? a.s, withBad(other()))] });
        bump("atomic:save_weeks bad second week");
        expectRefused("save_weeks, bad recipe in 2nd week", r.error, "23503");
        if ((await farSnap()) !== before) fail(`save_weeks with a bad 2nd week changed the weeks (seed ${SEED}, iteration ${k})`);
      }
      // A1b: the bad row in the first week, a valid (new) third week after it.
      {
        const before = await farSnap();
        const r = await sbA.rpc("save_weeks", { p_household: H1, p_weeks: [payload(F, a.s, withBad(a.planned), a.flags), payload(F3, a.s, other())] });
        bump("atomic:save_weeks bad first week");
        expectRefused("save_weeks, bad recipe in 1st week", r.error, "23503");
        if ((await farSnap()) !== before) fail(`save_weeks with a bad 1st week changed the weeks (iteration ${k})`);
      }
      // A1c: other invalid values in the last recipe row (not-null, type): nothing changes either.
      {
        const before = await farSnap();
        const p2 = payload(F2, b?.s ?? a.s, other());
        const bad = k % 2 ? { ...p2.recipes[0], recipe_id: null } : { ...p2.recipes[0], multiplier: "trois" };
        const r = await sbA.rpc("save_weeks", { p_household: H1, p_weeks: [payload(F, changed(a.s), []), { ...p2, recipes: [...p2.recipes.slice(1), bad] }] });
        bump("atomic:save_weeks invalid value");
        expectRefused(`save_weeks, ${k % 2 ? "null recipe id" : "bad multiplier"}`, r.error, k % 2 ? "23502" : "22P02");
        if ((await farSnap()) !== before) fail(`save_weeks with an invalid value changed the weeks (iteration ${k})`);
      }
      // A1d: the same through the library (saveWeeks): it throws, no step-by-step fallback, nothing changes.
      {
        const before = await farSnap();
        const writes = fallbackWrites.length;
        let err: unknown = null;
        await lib.saveWeeks(H1, [{ week: F, settings: changed(a.s), planned: other() }, { week: F2, settings: a.s, planned: withBad(other()) }], sv).catch((e) => (err = e));
        bump("atomic:lib.saveWeeks bad second week");
        expectRefused("lib.saveWeeks, bad recipe in 2nd week", err, "23503");
        if (fallbackWrites.length !== writes) fail(`lib.saveWeeks fell back to step-by-step writes: ${fallbackWrites.slice(writes).join(", ")}`);
        if ((await farSnap()) !== before) fail(`lib.saveWeeks with a bad 2nd week changed the weeks (iteration ${k})`);
      }

      // A2: replace_list with an unknown catalogue article on its last row: the list stays as it was, ticks included.
      {
        const planId = a.saved.plan.id;
        const before = (await farRows(planId)).map((r) => JSON.stringify(r)).sort().join("\n");
        const rows = lib.listRows(a.saved.items.slice(1), recipes, ingredients, catalog);
        const r = await sbA.rpc("replace_list", { p_plan: planId, p_rows: [...rows, { ingredient_id: bogus(), label: "TEST inconnu", quantity_text: "1", aisle: "autre", pantry: false, position: rows.length }] });
        bump("atomic:replace_list bad article");
        expectRefused("replace_list, unknown article", r.error, "23503");
        const after = (await farRows(planId)).map((r) => JSON.stringify(r)).sort().join("\n");
        if (after !== before) fail(`replace_list with an unknown article changed the list (iteration ${k})`);
        if (hasMakeList) {
          // make_list: neither the lines nor the plan's list_signature change.
          const snap = await farSnap();
          const m = await sbA.rpc("make_list", { p_plan: planId, p_rows: [...rows, { ingredient_id: bogus(), label: "TEST inconnu", quantity_text: "1", aisle: "autre", pantry: false, position: rows.length }], p_signature: "audit-bad" });
          bump("atomic:make_list bad article");
          expectRefused("make_list, unknown article", m.error, "23503");
          if ((await farSnap()) !== snap) fail(`make_list with an unknown article changed the list or its signature (iteration ${k})`);
        }
        // Through the library: a recipe line pointing to an article that does not exist.
        const fakeId = bogus();
        const host = a.saved.items.find((i) => !i.already_bought)?.recipe_id ?? a.planned[0].id; // a recipe still to buy
        const ing = [...ingredients, { ...(ingByRecipe.get(host)?.[0] ?? ingredients[0]), id: bogus(), recipe_id: host, ingredient_id: fakeId, name: "TEST inconnu", quantity: 1, unit: null, optional: false }];
        const real = catalog.find((c) => c.aisle !== NO_AISLE && !c.pantry) ?? catalog[0];
        const cat = [...catalog, { ...real, id: fakeId, name: "TEST inconnu", pantry: false, household_id: null }];
        let err: unknown = null;
        await lib.generateList(planId, a.saved.items, recipes, ing as never, cat as never).catch((e) => (err = e));
        bump("atomic:lib.generateList bad article");
        expectRefused("lib.generateList, unknown article", err, "23503");
        if ((await farRows(planId)).map((r) => JSON.stringify(r)).sort().join("\n") !== before) fail(`lib.generateList with an unknown article changed the list (iteration ${k})`);
        // And a valid remake keeps the ticks of generated lines still on the list, manual items untouched.
        const prev = await farRows(planId);
        const keyOf = (x: { ingredient_id: string | null; label: string }) => x.ingredient_id ?? `label:${x.label}`;
        const tickedGen = new Set(prev.filter((x) => x.checked && !x.manual).map(keyOf));
        await lib.generateList(planId, a.saved.items.slice(1), recipes, ingredients, catalog);
        const now = await farRows(planId);
        bump("atomic:replace_list valid remake");
        for (const x of now.filter((x) => !x.manual)) if (x.checked !== tickedGen.has(keyOf(x))) fail(`remake: "${x.label}" checked=${x.checked}, ticked before=${tickedGen.has(keyOf(x))}`);
        const manualBefore = prev.filter((x) => x.manual).map((x) => JSON.stringify(x)).sort().join("\n");
        if (now.filter((x) => x.manual).map((x) => JSON.stringify(x)).sort().join("\n") !== manualBefore) fail("remake changed a manual item");
      }

      // A3: postponeRecipe interrupted: the from-week payload is invalid (an unknown recipe among the others).
      // The next week is written first in the same call: it must be rolled back too.
      {
        const before = await farSnap();
        const moved = pick(a.planned);
        const fromPlanned = withBad(a.planned.filter((p) => p.id !== moved.id));
        fromPlanned.splice(int(0, fromPlanned.length), 0, moved);
        const already = !!b?.planned.some((p) => p.id === moved.id);
        let err: unknown = null;
        const res = await lib.postponeRecipe(H1, { week: F, settings: a.s, planned: fromPlanned, flags: a.flags }, moved.id, chance(0.5), a.s, sv).catch((e) => ((err = e), null));
        bump("atomic:postponeRecipe bad from-week");
        if (already) {
          if (res !== "already") fail(`postponeRecipe: recipe already in the next week, got ${err ? String(err) : "ok"}`);
        } else expectRefused("postponeRecipe, bad from-week", err, "23503");
        const now = await farSnap();
        if (now !== before) fail(`postponeRecipe with a bad from-week changed the weeks (iteration ${k})`);
        const [wf, wn] = [await lib.loadWeek(H1, F), await lib.loadWeek(H1, F2)];
        const inF = wf.items.some((i) => i.recipe_id === moved.id), inN = wn.items.some((i) => i.recipe_id === moved.id);
        if (!inF || (inN && !already)) fail(`after an interrupted postpone: in from-week ${inF}, in next week ${inN}`);
        if (!b && wn.plan) fail("an interrupted postpone created the next week");
      }
      // A4: postponeRecipe whose request is lost before the server (nothing changed), then after the server answered
      // (both weeks changed): the recipe is in exactly one week, and the page's retry answers "already".
      {
        const moved = pick(a.planned.filter((p) => !b?.planned.some((q) => q.id === p.id)));
        if (moved) {
          const before = await farSnap();
          const from = { week: F, settings: a.s, planned: a.planned, flags: a.flags };
          injectFault = { path: "/rest/v1/rpc/save_weeks", method: "POST", when: "before" };
          const e1 = await lib.postponeRecipe(H1, from, moved.id, false, a.s, sv).then(() => null, (e) => e);
          if (!e1) fail("dropped postpone request reported no error");
          if ((await farSnap()) !== before) fail("a postpone lost before the server changed the weeks");
          injectFault = { path: "/rest/v1/rpc/save_weeks", method: "POST", when: "after" };
          const e2 = await lib.postponeRecipe(H1, from, moved.id, true, a.s, sv).then(() => null, (e) => e);
          bump("atomic:postponeRecipe lost request/response");
          if (!e2) fail("postpone with a lost response reported no error");
          const [wf, wn] = [await lib.loadWeek(H1, F), await lib.loadWeek(H1, F2)];
          const inF = wf.items.some((i) => i.recipe_id === moved.id);
          const n = wn.items.find((i) => i.recipe_id === moved.id);
          if (inF || !n || n.multiplier !== moved.multiplier || !n.postponed || !n.already_bought) fail(`postpone with a lost response: in from-week ${inF}, next ${JSON.stringify(n)}`);
          const others = a.planned.filter((p) => p.id !== moved.id).map((p) => `${p.id}×${p.multiplier}`).join(" ");
          if (wf.items.map((i) => `${i.recipe_id}×${i.multiplier}`).join(" ") !== others) fail("postpone changed the other recipes of the from-week");
          const retry = await lib.postponeRecipe(H1, from, moved.id, true, a.s, sv);
          if (retry !== "already") fail(`page retry after a lost response: ${JSON.stringify(retry).slice(0, 120)}`);
        }
      }
      // A5: replace_list whose response is lost: the new list is there in full (or, lost before, the old one).
      {
        const planId = a.saved.plan.id;
        const before = (await farRows(planId)).map((r) => JSON.stringify(r)).sort().join("\n");
        injectFault = { path: `/rest/v1/rpc/${listRpc}`, method: "POST", when: "before" };
        await lib.generateList(planId, a.saved.items, recipes, ingredients, catalog).catch(() => undefined);
        if ((await farRows(planId)).map((r) => JSON.stringify(r)).sort().join("\n") !== before) fail("a list remake lost before the server changed the list");
        injectFault = { path: `/rest/v1/rpc/${listRpc}`, method: "POST", when: "after" };
        await lib.generateList(planId, a.saved.items, recipes, ingredients, catalog).catch(() => undefined);
        const got = (await farRows(planId)).filter((r) => !r.manual).map((r) => `${r.label}|${r.quantity_text ?? ""}`).sort().join("\n");
        const want = lib.listRows(a.saved.items, recipes, ingredients, catalog).map((r) => `${r.label}|${r.quantity_text ?? ""}`).sort().join("\n");
        bump("atomic:replace_list lost request/response");
        if (got !== want) fail("a list remake whose response was lost left a partial list");
      }
    }
    must(await sbA.from("week_plans").delete().eq("household_id", H1).in("week_start", FAR), "delete far weeks");
    await verify();
    for (const [k, v] of codes) atomicReport.push(`${String(v).padStart(4)}× ${k}`);
    console.log("\nAtomicity (refusal codes):");
    for (const r of atomicReport) console.log(`  ${r}`);
  } finally {
    // ---------- Cleanup: plans (cascade to recipes and lists), then leave both households ----------
    curType = "cleanup";
    for (const [sb, h, who] of [[sbA, H1, "A"], [sbB, H2, "B"]] as const) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const d = await sb.from("week_plans").delete().eq("household_id", h);
        const left = await sb.from("week_plans").select("id").eq("household_id", h);
        if (!d.error && !left.error && !left.data!.length) {
          console.log(`cleanup ${who}: plans deleted`);
          break;
        }
        if (attempt === 2) fail(`cleanup ${who}: ${JSON.stringify(d.error ?? left.error ?? left.data)}`);
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        const l = await sb.from("household_members").delete().eq("household_id", h);
        const still = await sb.from("households").select("id").eq("id", h);
        if (!l.error && !still.error && !still.data!.length) {
          console.log(`cleanup ${who}: left household ${h} (no longer visible)`);
          break;
        }
        if (attempt === 2) fail(`leave ${who}: ${JSON.stringify(l.error ?? still.error ?? still.data)}`);
      }
    }
  }

  // ---------- Summary ----------
  console.log(`\n===== SUMMARY (seed ${SEED}, ${((Date.now() - t0) / 1000).toFixed(0)} s, ${requests} HTTP requests) =====`);
  console.log("Operations (each followed by a full re-read of the database):");
  for (const [k, v] of doneCounts) console.log(`${String(v).padStart(6)}  ${k}`);
  console.log("Calls and checks:");
  for (const [k, v] of [...counts].sort()) console.log(`${String(v).padStart(6)}  ${k}`);
  console.log(`RLS probes: ${[...counts].filter(([k]) => k.startsWith("rls:")).reduce((a, [, v]) => a + v, 0)}`);
  if (notes.size) {
    console.log("Notes:");
    for (const [k, v] of notes) console.log(`${String(v).padStart(6)}  ${k}`);
  }
  console.log("Library requests (real src/lib code, by method and path):");
  for (const [k, v] of [...libCalls].sort()) console.log(`${String(v).padStart(6)}  ${k}`);
  curType = "rpc-path";
  if (!libCalls.get("POST /rpc/save_weeks")) fail("the library never called save_weeks");
  const libMake = libCalls.get("POST /rpc/make_list") ?? 0, libReplace = libCalls.get("POST /rpc/replace_list") ?? 0;
  if (hasMakeList) {
    // 0016 applied: every list goes through make_list, replace_list is never needed.
    if (!libMake) fail("the library never called make_list");
    if (libReplace) fail(`make_list exists but the library still called replace_list ${libReplace}×`);
    if (makeList202) fail(`make_list answered PGRST202 ${makeList202}× although it exists`);
  } else {
    // 0016 not applied: each make_list call answers PGRST202 and is followed by replace_list.
    if (!libReplace) fail("the library never called replace_list");
    if (libMake !== libReplace) fail(`make_list calls ${libMake} ≠ replace_list fallbacks ${libReplace}`);
    if (makeList202 < libMake) fail(`make_list calls ${libMake} but only ${makeList202} PGRST202 answers`);
  }
  console.log(`Lists: make_list ${hasMakeList ? "present" : "absent"} — library make_list ${libMake}× (PGRST202 ${makeList202}×), replace_list ${libReplace}×`);
  if (pgrst202.length) fail(`PGRST202 (function missing) ${pgrst202.length}×: ${pgrst202[0]}`);
  if (fallbackWrites.length) fail(`library wrote step by step (fallback) ${fallbackWrites.length}×: ${[...new Set(fallbackWrites)].join(", ")}`);
  console.log(`PGRST202 answers: ${pgrst202.length}; step-by-step library writes: ${fallbackWrites.length}`);
  console.log(`Flaky (network, retried/resynced): ${flaky.length}`);
  for (const f of flaky) console.log(`  #${f.op} ${f.type}: ${f.message}`);
  console.log(`Failures: ${failures.length}`);
  for (const f of failures.slice(0, 40)) console.log(`  #${f.op} ${f.type}: ${f.message}\n     repro (seed ${SEED}):\n       ${f.repro.join("\n       ")}`);
  process.exit(failures.length ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(2);
});
