import { lang } from "./i18n";

// Weekly suggestions: pick N suppers that fit the season, respect the variety rules,
// avoid recent repeats and share fresh ingredients (less waste).

export type Season = "printemps" | "ete" | "automne" | "hiver";

export const SEASON_LABEL: Record<Season, string> = {
  printemps: "Printemps",
  ete: "Été",
  automne: "Automne",
  hiver: "Hiver",
};

const SEASON_EN: Record<Season, string> = { printemps: "Spring", ete: "Summer", automne: "Fall", hiver: "Winter" };

/** Season name in the household's language. */
export function seasonLabel(s: Season): string {
  return lang() === "en" ? SEASON_EN[s] : SEASON_LABEL[s];
}

/** Dish types never proposed as a supper. */
export const NOT_A_MEAL = new Set(["accompagnement"]);

export type PlannerRecipe = {
  id: string;
  /** Portions the recipe makes as written (quantities are never scaled, only multiplied by a whole number). */
  servings?: number;
  dishType: string | null;
  protein: string | null;
  seasons: string[];
  rating: number | null;
  /** Perishable catalogue ingredients (pantry staples excluded). */
  ingredientIds: string[];
  /** Weeks since it was last planned, null if never. */
  weeksSinceEaten: number | null;
  /** Ingredients on sale this week (phase 3). */
  active?: boolean;
};

export type Rules = {
  maxSameDishType: number;
  maxSameProtein: number;
  cooldownWeeks: number;
};

/** Astronomical seasons, close enough for Québec. */
export function seasonOf(d: Date): Season {
  const md = (d.getMonth() + 1) * 100 + d.getDate();
  if (md >= 320 && md < 621) return "printemps";
  if (md >= 621 && md < 922) return "ete";
  if (md >= 922 && md < 1221) return "automne";
  return "hiver";
}

/** Monday of the week containing d, as YYYY-MM-DD (local time). */
export function weekStart(d: Date): string {
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

/** Portions assumed for a recipe that does not say. */
export const DEFAULT_SERVINGS = 4;

export type Planned = { id: string; multiplier: number };

/** Each extra multiple (×2, ×3…) counts like 2 extra portions: variety wins over cooking one recipe many times. */
const MULTIPLY_COST = 2;

/**
 * Whole multipliers (×1, ×2…) so the recipes reach at least `target` portions with as little extra as possible.
 * Quantities are never adapted otherwise: a recipe for 4 is cooked for 4, 8, 12…
 */
export function assignMultipliers(servings: number[], target: number): number[] {
  if (!servings.length) return [];
  const s = servings.map((x) => (x > 0 ? x : DEFAULT_SERVINGS));
  const share = target / s.length;
  const m = s.map((x) => Math.max(1, Math.round(share / x)));
  const total = () => m.reduce((sum, k, i) => sum + k * s[i], 0);

  while (total() < target) {
    // The addition that reaches the target with the least overshoot, else the biggest step.
    const t = total();
    let best = 0;
    for (let i = 1; i < s.length; i++) {
      const a = t + s[i], b = t + s[best];
      const better = a >= target ? b < target || a < b || (a === b && m[i] < m[best]) : b < target && s[i] > s[best];
      if (better) best = i;
    }
    m[best]++;
  }
  // Trim: drop a multiple while the target is still met, biggest recipes first.
  for (let changed = true; changed; ) {
    changed = false;
    const order = s.map((_, i) => i).sort((a, b) => s[b] - s[a]);
    for (const i of order) {
      if (m[i] > 1 && total() - s[i] >= target) {
        m[i]--;
        changed = true;
        break;
      }
    }
  }
  return m;
}

export function totalPortions(plan: Planned[], servingsOf: (id: string) => number): number {
  return plan.reduce((sum, p) => sum + p.multiplier * servingsOf(p.id), 0);
}

/**
 * Pick at most `count` recipes reaching at least `target` portions with the least extra (user rule: the number
 * of recipes is a maximum; less extra wins over more recipes). Several varied draws per number of recipes are
 * compared; the draws themselves follow the season and variety rules.
 */
export function planWeek(
  recipes: PlannerRecipe[],
  count: number,
  target: number,
  rules: Rules,
  season: Season,
  opts: { keep?: string[]; avoid?: string[]; random?: () => number; draws?: number; filters?: Filters } = {},
): Planned[] {
  const servings = new Map(recipes.map((r) => [r.id, r.servings ?? DEFAULT_SERVINGS]));
  const draw = (n: number) => {
    let best: { plan: Planned[]; extra: number; cost: number } | null = null;
    for (let d = 0; d < (opts.draws ?? 30); d++) {
      const keep = opts.keep?.slice(0, n);
      const ids = suggest(recipes, n, rules, season, { keep, avoid: opts.avoid, random: opts.random, filters: opts.filters });
      const mult = assignMultipliers(ids.map((id) => servings.get(id)!), target);
      const plan = ids.map((id, i) => ({ id, multiplier: mult[i] }));
      const extra = totalPortions(plan, (id) => servings.get(id)!) - target;
      // The least extra, and as few multiplied recipes as possible (more variety).
      const cost = extra + mult.reduce((a, k) => a + (k - 1), 0) * MULTIPLY_COST;
      if (!best || cost < best.cost) best = { plan, extra, cost };
      if (extra === 0 && mult.every((k) => k === 1)) break;
    }
    return best;
  };

  // From the maximum down: the least costly week wins; on a tie, the one with more recipes (more variety).
  let best: { plan: Planned[]; cost: number } | null = null;
  for (let n = count; n >= 1; n--) {
    const candidate = draw(n);
    if (candidate && (!best || candidate.cost < best.cost - 1e-9)) best = candidate;
  }
  return best?.plan ?? [];
}

/** Whether a week respects the variety rules (the planner relaxes them when there are not enough recipes). */
export function respectsRules(plan: Planned[], recipes: PlannerRecipe[], rules: Rules): boolean {
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const picked = plan.map((p) => byId.get(p.id)).filter((r): r is PlannerRecipe => !!r);
  const count = (key: "dishType" | "protein", v: string | null) => (v ? picked.filter((r) => r[key] === v).length : 0);
  return picked.every(
    (r) =>
      count("dishType", r.dishType) <= rules.maxSameDishType &&
      count("protein", r.protein) <= rules.maxSameProtein &&
      (r.weeksSinceEaten === null || r.weeksSinceEaten >= rules.cooldownWeeks),
  );
}

/** Replacement for one recipe of the week that keeps the portion target as well as possible. */
export function swapInPlan(
  recipes: PlannerRecipe[],
  plan: Planned[],
  replaceId: string,
  target: number,
  rules: Rules,
  season: Season,
  opts: { avoid?: string[]; random?: () => number; filters?: Filters } = {},
): Planned[] | null {
  const servings = new Map(recipes.map((r) => [r.id, r.servings ?? DEFAULT_SERVINGS]));
  const current = plan.map((p) => p.id);
  const avoid = [...(opts.avoid ?? [])];
  let best: { plan: Planned[]; cost: number } | null = null;
  for (let k = 0; k < 6; k++) {
    const next = swapFor(recipes, current, replaceId, rules, season, { avoid, random: opts.random, filters: opts.filters });
    if (!next) break;
    avoid.push(next);
    const ids = current.map((id) => (id === replaceId ? next : id));
    const mult = assignMultipliers(ids.map((id) => servings.get(id)!), target);
    const candidate = ids.map((id, i) => ({ id, multiplier: mult[i] }));
    const cost = totalPortions(candidate, (id) => servings.get(id)!) - target + mult.reduce((a, m) => a + (m - 1), 0) * MULTIPLY_COST + k * 0.3;
    if (!best || cost < best.cost) best = { plan: candidate, cost };
  }
  return best?.plan ?? null;
}

function fitsRules(r: PlannerRecipe, picked: PlannerRecipe[], rules: Rules): boolean {
  if (r.dishType && picked.filter((p) => p.dishType === r.dishType).length >= rules.maxSameDishType) return false;
  if (r.protein && picked.filter((p) => p.protein === r.protein).length >= rules.maxSameProtein) return false;
  return true;
}

function eligible(r: PlannerRecipe, rules: Rules): boolean {
  if (r.active === false) return false;
  if (r.dishType && NOT_A_MEAL.has(r.dishType)) return false;
  return r.weeksSinceEaten === null || r.weeksSinceEaten >= rules.cooldownWeeks;
}

export function score(r: PlannerRecipe, season: Season, picked: PlannerRecipe[], random: () => number): number {
  let s = 1;
  if (r.seasons.length && !r.seasons.includes(season)) s -= 3;
  if (r.rating) s += (r.rating - 3) * 0.25; // 5 stars: +0.5 at most (user, 2026-09-30)
  if (r.weeksSinceEaten === null) s += 0.3; // not planned yet
  else s += Math.min(r.weeksSinceEaten, 12) * 0.05; // long time no see
  // Shared fresh ingredients with the rest of the week: an opened bunch of coriander gets used up.
  const pickedIngredients = new Set(picked.flatMap((p) => p.ingredientIds));
  s += r.ingredientIds.filter((i) => pickedIngredients.has(i)).length * 0.3;
  return s + random() * 1.2;
}

function pickBest(
  pool: PlannerRecipe[],
  picked: PlannerRecipe[],
  rules: Rules,
  season: Season,
  random: () => number,
): PlannerRecipe | null {
  let best: PlannerRecipe | null = null;
  let bestScore = -Infinity;
  for (const r of pool) {
    if (!fitsRules(r, picked, rules)) continue;
    const s = score(r, season, picked, random);
    if (s > bestScore) {
      best = r;
      bestScore = s;
    }
  }
  return best;
}

/**
 * Suggest `count` recipe ids. `keep` are already chosen (kept in order); `avoid` are never proposed.
 * When the rules cannot be met with the recipes available, they are relaxed rather than returning fewer meals.
 */
/** Categories the household allows this week; recipes outside them are never proposed (not even as a fallback). */
export type Filters = {
  /** Seasons ticked; a recipe must be marked for at least one of them. Empty = all seasons. */
  seasons?: string[];
  /** Dish types to leave out this week. */
  excludeDishTypes?: string[];
};

export function passesFilters(r: PlannerRecipe, f: Filters | undefined): boolean {
  if (!f) return true;
  // A recipe with every season unticked is never proposed when seasons are filtered.
  if (f.seasons?.length && !r.seasons.some((s) => f.seasons!.includes(s))) return false;
  if (r.dishType && f.excludeDishTypes?.includes(r.dishType)) return false;
  return true;
}

export function suggest(
  recipes: PlannerRecipe[],
  count: number,
  rules: Rules,
  season: Season,
  opts: { keep?: string[]; avoid?: string[]; random?: () => number; filters?: Filters } = {},
): string[] {
  const random = opts.random ?? Math.random;
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const picked = (opts.keep ?? []).map((id) => byId.get(id)).filter((r): r is PlannerRecipe => !!r);
  const taken = new Set([...picked.map((r) => r.id), ...(opts.avoid ?? [])]);
  recipes = recipes.filter((r) => passesFilters(r, opts.filters));

  const relaxations: Rules[] = [
    rules,
    { ...rules, cooldownWeeks: 0 },
    { ...rules, cooldownWeeks: 0, maxSameProtein: rules.maxSameProtein + 1, maxSameDishType: rules.maxSameDishType + 1 },
    { cooldownWeeks: 0, maxSameProtein: Infinity, maxSameDishType: Infinity },
  ];
  for (const r of relaxations) {
    while (picked.length < count) {
      const pool = recipes.filter((x) => !taken.has(x.id) && eligible(x, r));
      const next = pickBest(pool, picked, r, season, random);
      if (!next) break;
      picked.push(next);
      taken.add(next.id);
    }
    if (picked.length >= count) break;
  }
  return picked.map((r) => r.id);
}

/** Best replacement for `replaceId` given the rest of the week; `avoid` = recipes already swapped away. */
export function swapFor(
  recipes: PlannerRecipe[],
  current: string[],
  replaceId: string,
  rules: Rules,
  season: Season,
  opts: { avoid?: string[]; random?: () => number; filters?: Filters } = {},
): string | null {
  const others = current.filter((id) => id !== replaceId);
  const result = suggest(recipes, others.length + 1, rules, season, {
    keep: others,
    avoid: [replaceId, ...(opts.avoid ?? [])],
    random: opts.random,
    filters: opts.filters,
  });
  return result.length > others.length ? result[result.length - 1] : null;
}
