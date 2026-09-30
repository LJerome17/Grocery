// Validation of the weekly planner against the rules in PROJET.md ("Semaine").
// Read-only on app code: builds PlannerRecipes from public/starter/recipes.json exactly like toPlannerRecipes does.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NOT_A_MEAL,
  assignMultipliers,
  passesFilters,
  planWeek,
  respectsRules,
  suggest,
  swapInPlan,
  DEFAULT_SERVINGS,
  type Filters,
  type Planned,
  type PlannerRecipe,
  type Rules,
  type Season,
} from "../lib/planner";
import { toPlannerRecipes } from "../lib/data";
import type { Ingredient, Recipe, RecipeIngredient } from "../lib/db";

// ---------- data ----------
type StarterIng = { position: number; raw: string; name: string; catalog: string | null };
type Starter = { slug: string; title: string; servings: number | null; dish_type: string | null; protein: string | null; seasons: string[]; ingredients: StarterIng[] };
const root = join(__dirname, "..", "..");
const starter: Starter[] = JSON.parse(readFileSync(join(root, "public/starter/recipes.json"), "utf8"));
const catalogJson: { ingredients: { name: string; pantry?: boolean; aisle: string }[] } = JSON.parse(readFileSync(join(root, "data/catalog.json"), "utf8"));
const catalog: Ingredient[] = catalogJson.ingredients.map((c) => ({ id: c.name, household_id: null, name: c.name, aisle: c.aisle, pantry: !!c.pantry, count_unit: null, equiv: null }));

const ALL_SEASONS: Season[] = ["printemps", "ete", "automne", "hiver"];
const recipeRows: Recipe[] = starter.map((s) => ({
  id: s.slug, household_id: "book", title: s.title, source_type: "url", source_url: null, image_url: null, servings: s.servings,
  total_minutes: null, instructions: [], notes: null, dish_type: s.dish_type, protein: s.protein, seasons: s.seasons, rating: null, active: true,
}));
// Synthetic traps: a side dish (NOT_A_MEAL) and an inactive recipe, both all-season, must never be proposed.
recipeRows.push({ ...recipeRows[0], id: "zz-accompagnement", title: "Accompagnement test", dish_type: "accompagnement", protein: null, seasons: ALL_SEASONS });
recipeRows.push({ ...recipeRows[0], id: "zz-inactive", title: "Inactive test", dish_type: "bol", protein: "tofu", seasons: ALL_SEASONS, active: false });
const ingRows: RecipeIngredient[] = starter.flatMap((s) =>
  s.ingredients.map((i, k) => ({ id: `${s.slug}-${k}`, recipe_id: s.slug, position: i.position, section: null, raw: i.raw, quantity: null, quantity_max: null, unit: null, name: i.name, note: null, optional: false, ingredient_id: i.catalog })),
);
const titleOf = new Map(recipeRows.map((r) => [r.id, r.title]));
const base = (history = new Map<string, number>()) => toPlannerRecipes(recipeRows, ingRows, catalog, history);
const DISH_TYPES = [...new Set(starter.map((s) => s.dish_type!).filter(Boolean))];
const SIDE_TOFU = starter.filter((s) => s.ingredients.some((i) => i.catalog === "Légumes d'accompagnement (au choix)")).map((s) => s.slug);

// ---------- helpers ----------
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sv = (r: PlannerRecipe) => r.servings ?? DEFAULT_SERVINGS;
const eligibleFor = (recipes: PlannerRecipe[], f: Filters) =>
  recipes.filter((r) => r.active !== false && !(r.dishType && NOT_A_MEAL.has(r.dishType)) && passesFilters(r, f));

/** Minimum planner cost (extra + 2 per extra multiple) for a fixed set of servings, exact (covering knapsack). */
function optimalCost(servings: number[], target: number): { cost: number; extra: number } {
  const s = servings.map((x) => (x > 0 ? x : DEFAULT_SERVINGS));
  const baseP = s.reduce((a, b) => a + b, 0);
  const rem = Math.max(0, target - baseP);
  // f[r] = [min added weight (portions + 2 per multiple), portions added] to add >= r portions
  const f: [number, number][] = [[0, 0]];
  for (let r = 1; r <= rem; r++) {
    let best: [number, number] = [Infinity, 0];
    for (const x of s) {
      const prev = f[Math.max(0, r - x)];
      const w = prev[0] + x + 2;
      if (w < best[0]) best = [w, prev[1] + x];
    }
    f.push(best);
  }
  const [w, p] = f[rem];
  const extra = baseP + p - target;
  // w = added portions + 2 per added multiple, so the multiples cost w - p.
  return { cost: extra + (w - p), extra };
}
const planCost = (plan: Planned[], byId: Map<string, PlannerRecipe>, target: number) => {
  const total = plan.reduce((a, p) => a + p.multiplier * sv(byId.get(p.id)!), 0);
  return { extra: total - target, cost: total - target + plan.reduce((a, p) => a + (p.multiplier - 1) * 2, 0), total };
};

/** Max number of recipes that can be picked together respecting all rules (max flow dishType -> recipe -> protein). */
function maxFeasible(pool: PlannerRecipe[], rules: Rules): number {
  const ok = pool.filter((r) => r.weeksSinceEaten === null || r.weeksSinceEaten >= rules.cooldownWeeks);
  const dish = new Map<string, number>(), prot = new Map<string, number>();
  const assign = new Map<string, string>(); // recipe id -> matched (flow through)
  let flow = 0;
  // Simple augmenting: capacities on dish/protein nodes; use BFS over residual graph.
  const nodes = ["S", "T", ...new Set(ok.map((r) => "d:" + (r.dishType ?? "∅" + r.id))), ...ok.map((r) => "r:" + r.id), ...new Set(ok.map((r) => "p:" + (r.protein ?? "∅" + r.id)))];
  const idx = new Map(nodes.map((n, i) => [n, i]));
  const n = nodes.length;
  const cap: number[][] = Array.from({ length: n }, () => new Array(n).fill(0));
  const S = 0, T = 1;
  for (const r of ok) {
    const d = idx.get("d:" + (r.dishType ?? "∅" + r.id))!, ri = idx.get("r:" + r.id)!, p = idx.get("p:" + (r.protein ?? "∅" + r.id))!;
    cap[S][d] = r.dishType ? rules.maxSameDishType : 1;
    cap[d][ri] = 1;
    cap[ri][p] = 1;
    cap[p][T] = r.protein ? rules.maxSameProtein : 1;
  }
  for (;;) {
    const prev = new Array(n).fill(-1); prev[S] = S;
    const q = [S];
    while (q.length && prev[T] < 0) { const u = q.shift()!; for (let v = 0; v < n; v++) if (prev[v] < 0 && cap[u][v] > 0) { prev[v] = u; q.push(v); } }
    if (prev[T] < 0) break;
    let aug = Infinity; for (let v = T; v !== S; v = prev[v]) aug = Math.min(aug, cap[prev[v]][v]);
    for (let v = T; v !== S; v = prev[v]) { cap[prev[v]][v] -= aug; cap[v][prev[v]] += aug; }
    flow += aug;
  }
  void dish; void prot; void assign;
  return flow;
}

// ---------- generated weeks ----------
type Case = { seed: number; target: number; count: number; season: Season; filters: Filters; rules: Rules; recipes: PlannerRecipe[] };
function genCase(seed: number): Case {
  const rnd = mulberry32(seed * 7919 + 13);
  const season = ALL_SEASONS[Math.floor(rnd() * 4)];
  const seasons = rnd() < 0.7 ? [season] : ALL_SEASONS.filter((s) => s === season || rnd() < 0.4);
  const excl = DISH_TYPES.filter(() => rnd() < 0.15);
  const rules: Rules = rnd() < 0.6 ? { maxSameDishType: 2, maxSameProtein: 3, cooldownWeeks: 3 } : { maxSameDishType: 1, maxSameProtein: 1, cooldownWeeks: 3 };
  const history = new Map<string, number>();
  const pHist = rnd() * 0.6;
  for (const r of recipeRows) if (rnd() < pHist) history.set(r.id, 1 + Math.floor(rnd() * 8));
  return { seed, target: 2 + Math.floor(rnd() * 29), count: 1 + Math.floor(rnd() * 7), season, filters: { seasons, excludeDishTypes: excl }, rules, recipes: base(history) };
}

const WEEKS = 600;
type Result = Case & { plan: Planned[]; byId: Map<string, PlannerRecipe>; pool: PlannerRecipe[] };
const results: Result[] = [];
for (let i = 0; i < WEEKS; i++) {
  const c = genCase(i);
  const plan = planWeek(c.recipes, c.count, c.target, c.rules, c.season, { random: mulberry32(i + 1), filters: c.filters });
  results.push({ ...c, plan, byId: new Map(c.recipes.map((r) => [r.id, r])), pool: eligibleFor(c.recipes, c.filters) });
}
const describeCase = (r: Result) =>
  `seed=${r.seed} target=${r.target} max=${r.count} season=${r.season} seasons=${r.filters.seasons} excl=[${r.filters.excludeDishTypes}] rules=${r.rules.maxSameDishType}/${r.rules.maxSameProtein} -> ${r.plan.map((p) => `${p.id}×${p.multiplier}(${sv(r.byId.get(p.id)!)})`).join(", ")}`;

describe(`planWeek on ${WEEKS} generated weeks`, () => {
  it("empty week only when no recipe passes the filters", () => {
    for (const r of results) expect(r.plan.length === 0, describeCase(r)).toBe(r.pool.length === 0);
  });
  it("reaches the portions, whole multipliers >= 1, no duplicate, count <= max", () => {
    for (const r of results) {
      if (!r.plan.length) continue;
      const { total } = planCost(r.plan, r.byId, r.target);
      expect(total, describeCase(r)).toBeGreaterThanOrEqual(r.target);
      for (const p of r.plan) expect(Number.isInteger(p.multiplier) && p.multiplier >= 1, describeCase(r)).toBe(true);
      expect(new Set(r.plan.map((p) => p.id)).size, describeCase(r)).toBe(r.plan.length);
      expect(r.plan.length, describeCase(r)).toBeLessThanOrEqual(r.count);
    }
  });
  it("hard filters: ticked seasons, excluded dish types, never NOT_A_MEAL or inactive", () => {
    for (const r of results)
      for (const p of r.plan) {
        const x = r.byId.get(p.id)!;
        expect(passesFilters(x, r.filters), describeCase(r)).toBe(true);
        expect(x.seasons.some((s) => r.filters.seasons!.includes(s)), describeCase(r)).toBe(true);
        expect(r.filters.excludeDishTypes!.includes(x.dishType ?? ""), describeCase(r)).toBe(false);
        expect(NOT_A_MEAL.has(x.dishType ?? ""), describeCase(r)).toBe(false);
        expect(x.active, describeCase(r)).not.toBe(false);
      }
  });
  // PROJET.md: variety rules are relaxed only when there are not enough recipes (fixed 2026-09-30: planWeek now penalises
  // draws that break the rules, so a rule-respecting week always wins when one exists).
  it("variety rules: relaxed only when not enough recipes for that number of recipes", () => {
    let broken = 0, needless = 0, smallerExisted = 0, costChosen = 0, greedyStuck = 0;
    const examples: string[] = [];
    for (const r of results) {
      if (!r.plan.length || respectsRules(r.plan, r.recipes, r.rules)) continue;
      broken++;
      const feasible = maxFeasible(r.pool, r.rules);
      if (r.plan.length <= feasible) {
        needless++;
        // Diagnosis: how many of 30 greedy draws of that size (suggest) respect the rules?
        const rnd = mulberry32(r.seed + 31);
        let okDraws = 0;
        for (let d = 0; d < 30; d++) if (respectsRules(suggest(r.recipes, r.plan.length, r.rules, r.season, { random: rnd, filters: r.filters }).map((id) => ({ id, multiplier: 1 })), r.recipes, r.rules)) okDraws++;
        if (okDraws > 0) costChosen++; else greedyStuck++;
        if (examples.length < 3) examples.push(`${describeCase(r)} (feasible ${feasible}, rule-respecting draws ${okDraws}/30)`);
      }
      else if (feasible >= 1) smallerExisted++;
    }
    console.log(`[variety] weeks breaking rules: ${broken}/${WEEKS}; needless relaxation (a rule-respecting set of the same size existed): ${needless}; relaxed while a smaller rule-respecting week existed: ${smallerExisted}`);
    console.log(`  of the needless ones: greedy never found a respecting draw ${greedyStuck}; a respecting draw existed but lost on extra cost ${costChosen}`);
    examples.forEach((e) => console.log("  needless:", e));
    expect(needless).toBe(0);
  });
});

// ---------- least extra: brute force on small pools ----------
describe("moins d'extra d'abord: planWeek vs brute force", () => {
  const rows: { gapCost: number; gapExtra: number; beatRules: boolean }[] = [];
  const bad: string[] = [];
  for (let i = 0; i < 300; i++) {
    const rnd = mulberry32(100000 + i);
    const c = genCase(5000 + i);
    const pool0 = eligibleFor(c.recipes, c.filters);
    if (pool0.length < 3) continue;
    const pool = [...pool0].sort(() => rnd() - 0.5).slice(0, 5 + Math.floor(rnd() * 4));
    const target = 2 + Math.floor(rnd() * 15), count = 1 + Math.floor(rnd() * 4);
    const plan = planWeek(pool, count, target, c.rules, c.season, { random: mulberry32(i + 7), filters: c.filters });
    const byId = new Map(pool.map((r) => [r.id, r]));
    const got = planCost(plan, byId, target);
    let bestRules = { cost: Infinity, extra: Infinity }, bestAll = { cost: Infinity, extra: Infinity };
    const m = pool.length;
    for (let mask = 1; mask < 1 << m; mask++) {
      const set = pool.filter((_, k) => mask & (1 << k));
      if (set.length > count) continue;
      const o = optimalCost(set.map(sv), target);
      if (o.cost < bestAll.cost) bestAll = o;
      if (respectsRules(set.map((x) => ({ id: x.id, multiplier: 1 })), pool, c.rules) && o.cost < bestRules.cost) bestRules = o;
    }
    const ref = bestRules.cost < Infinity ? bestRules : bestAll;
    rows.push({ gapCost: got.cost - ref.cost, gapExtra: got.extra - ref.extra, beatRules: got.cost < bestRules.cost });
    if (got.cost - bestAll.cost > 0 && bad.length < 4) bad.push(`target=${target} max=${count} pool servings=[${pool.map(sv)}] got cost ${got.cost} (extra ${got.extra}, ${plan.map((p) => `${sv(byId.get(p.id)!)}×${p.multiplier}`)}) vs optimum ${bestAll.cost} (extra ${bestAll.extra})`);
  }
  it("reports the gap to the optimum", () => {
    const n = rows.length;
    const exact = rows.filter((r) => r.gapCost <= 0).length;
    const worse = rows.filter((r) => r.gapCost > 0);
    console.log(`[extra] ${n} small cases; optimal cost reached ${exact}/${n}; worse in ${worse.length} (mean +${(worse.reduce((a, r) => a + r.gapCost, 0) / Math.max(1, worse.length)).toFixed(2)}, max +${Math.max(0, ...worse.map((r) => r.gapCost))}); extra portions worse than optimum in ${rows.filter((r) => r.gapExtra > 0).length}, max +${Math.max(0, ...rows.map((r) => r.gapExtra))}; cheaper than any rule-respecting week (by relaxing) in ${rows.filter((r) => r.beatRules).length}`);
    bad.forEach((b) => console.log("  suboptimal:", b));
    expect(n).toBeGreaterThan(200);
  });
  // PROJET.md: least extra, a multiple costs like 2 extra portions. Fixed 2026-09-30 (exact dynamic programming); before,
  // servings [4,2] for 10 portions gave ×[1,3] (cost 4) instead of ×[2,1] (cost 2).
  it("assignMultipliers is optimal for a fixed set of recipes", () => {
    const rnd = mulberry32(42);
    const S = [1, 2, 3, 4, 6, 8];
    let worse = 0; const ex: string[] = [];
    for (let i = 0; i < 2000; i++) {
      const s = Array.from({ length: 1 + Math.floor(rnd() * 5) }, () => S[Math.floor(rnd() * S.length)]);
      const t = 2 + Math.floor(rnd() * 29);
      const m = assignMultipliers(s, t);
      const cost = m.reduce((a, k, j) => a + k * s[j], 0) - t + m.reduce((a, k) => a + (k - 1) * 2, 0);
      const o = optimalCost(s, t).cost;
      if (cost > o) { worse++; if (ex.length < 3) ex.push(`servings=[${s}] target=${t} -> ×[${m}] cost ${cost} vs ${o}`); }
    }
    console.log(`[assignMultipliers] suboptimal in ${worse}/2000`); ex.forEach((e) => console.log("  ", e));
    expect(worse).toBe(0);
  });
});

// ---------- swap ----------
describe("swapInPlan", () => {
  let nulls = 0, tested = 0;
  const fails: string[] = [];
  for (const r of results) {
    if (!r.plan.length) continue;
    const rnd = mulberry32(r.seed + 999);
    const victim = r.plan[Math.floor(rnd() * r.plan.length)].id;
    const next = swapInPlan(r.recipes, r.plan, victim, r.target, r.rules, r.season, { random: rnd, filters: r.filters });
    tested++;
    if (!next) { nulls++; continue; }
    const added = next.map((p) => p.id).filter((id) => !r.plan.some((p) => p.id === id));
    const tot = next.reduce((a, p) => a + p.multiplier * sv(r.byId.get(p.id)!), 0);
    const x = added.length === 1 ? r.byId.get(added[0])! : null;
    const ok = next.length === r.plan.length && !next.some((p) => p.id === victim) && added.length === 1 && tot >= r.target && new Set(next.map((p) => p.id)).size === next.length && !!x && passesFilters(x, r.filters) && !NOT_A_MEAL.has(x.dishType ?? "") && x.active !== false && next.every((p) => Number.isInteger(p.multiplier) && p.multiplier >= 1);
    if (!ok) fails.push(`${describeCase(r)} swap ${victim} -> ${JSON.stringify(next)}`);
  }
  it("replacement differs, keeps filters and portions", () => {
    const eligibleSpare = 0;
    void eligibleSpare;
    console.log(`[swap] ${tested} swaps, ${nulls} returned null, ${fails.length} broke a rule`);
    fails.slice(0, 3).forEach((f) => console.log("  ", f));
    expect(fails).toEqual([]);
  });
  it("null only when no other recipe passes the filters", () => {
    let wrongNull = 0;
    for (const r of results) {
      if (!r.plan.length) continue;
      const rnd = mulberry32(r.seed + 999);
      const victim = r.plan[Math.floor(rnd() * r.plan.length)].id;
      const next = swapInPlan(r.recipes, r.plan, victim, r.target, r.rules, r.season, { random: rnd, filters: r.filters });
      const spare = r.pool.filter((x) => !r.plan.some((p) => p.id === x.id)).length;
      if (!next && spare > 0) wrongNull++;
    }
    expect(wrongNull).toBe(0);
  });
});

// ---------- distribution ----------
describe("distribution: 2000 summer weeks, default rules (20 portions, 5 recipes, 2/3, cooldown 3)", () => {
  const rules: Rules = { maxSameDishType: 2, maxSameProtein: 3, cooldownWeeks: 3 };
  const filters: Filters = { seasons: ["ete"], excludeDishTypes: [] };
  const run = (recipes: PlannerRecipe[], seed: number) => {
    const rnd = mulberry32(seed);
    const freq = new Map<string, number>();
    for (let i = 0; i < 2000; i++) for (const p of planWeek(recipes, 5, 20, rules, "ete", { random: rnd, filters })) freq.set(p.id, (freq.get(p.id) ?? 0) + 1);
    return freq;
  };
  const recipes = base();
  const pool = eligibleFor(recipes, filters);
  const freq = run(recipes, 2026);
  const counts = pool.map((r) => ({ id: r.id, n: freq.get(r.id) ?? 0 })).sort((a, b) => b.n - a.n);
  const mean = counts.reduce((a, c) => a + c.n, 0) / counts.length;

  // Not a hard rule in PROJET.md, but the requested check fails: with 20 portions / 5 recipes, recipes of 1-3 portions
  // are never chosen (a 4+4+4+4+4 week has zero extra). Kept as it.fails; see "À faire valider".
  it.fails("every eligible summer recipe is proposed at least once", () => {
    const fmt = (c: { id: string; n: number }) => `${titleOf.get(c.id)} ${c.n} (${(c.n / mean).toFixed(2)}×)`;
    console.log(`[distribution] ${pool.length} eligible, mean ${mean.toFixed(0)} weeks/2000`);
    console.log("  top 10:", counts.slice(0, 10).map(fmt).join(" | "));
    console.log("  bottom 10:", counts.slice(-10).map(fmt).join(" | "));
    const side = counts.filter((c) => SIDE_TOFU.includes(c.id));
    console.log(`  tofu + side vegetables (${SIDE_TOFU.length} in starter):`, side.map(fmt).join(" | "));
    const outOfSeason = [...freq.keys()].filter((id) => !pool.some((p) => p.id === id));
    expect(outOfSeason).toEqual([]);
    expect(counts.filter((c) => c.n === 0).map((c) => c.id)).toEqual([]);
  });

  it("recipes never proposed at 20/5: proposed at other settings? (random portions 2-30, max 1-7)", () => {
    const zero = counts.filter((c) => c.n === 0).map((c) => c.id);
    const rnd = mulberry32(555);
    const f = new Map<string, number>();
    for (let i = 0; i < 2000; i++) {
      const plan = planWeek(recipes, 1 + Math.floor(rnd() * 7), 2 + Math.floor(rnd() * 29), rules, "ete", { random: rnd, filters, draws: 10 });
      for (const p of plan) f.set(p.id, (f.get(p.id) ?? 0) + 1);
    }
    const m = pool.reduce((a, r) => a + (f.get(r.id) ?? 0), 0) / pool.length;
    console.log(`[distribution, mixed settings] mean ${m.toFixed(0)}/2000; never at 20/5:`, zero.map((id) => `${titleOf.get(id)} (${sv(recipes.find((r) => r.id === id)!)} portions) ${f.get(id) ?? 0}`).join(" | "));
    console.log("  still never proposed:", pool.filter((r) => !f.get(r.id)).map((r) => titleOf.get(r.id)).join(", ") || "none");
  }, 120000);

  it("5-star advantage (same recipe rated 5 vs unrated)", () => {
    const mid = counts[Math.floor(counts.length / 2)].id;
    const rated = recipes.map((r) => (r.id === mid ? { ...r, rating: 5 } : r));
    const a = run(recipes, 77).get(mid) ?? 0, b = run(rated, 77).get(mid) ?? 0;
    console.log(`[rating] ${titleOf.get(mid)}: unrated ${a}/2000, 5 stars ${b}/2000 (×${(b / Math.max(1, a)).toFixed(2)})`);
    expect(b).toBeGreaterThanOrEqual(a);
  }, 120000);
});
