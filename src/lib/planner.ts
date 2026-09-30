// Weekly suggestions: pick N suppers that fit the season, respect the variety rules,
// avoid recent repeats and share fresh ingredients (less waste).

export type Season = "printemps" | "ete" | "automne" | "hiver";

export const SEASON_LABEL: Record<Season, string> = {
  printemps: "Printemps",
  ete: "Été",
  automne: "Automne",
  hiver: "Hiver",
};

/** Dish types never proposed as a supper. */
export const NOT_A_MEAL = new Set(["accompagnement"]);

export type PlannerRecipe = {
  id: string;
  dishType: string | null;
  protein: string | null;
  seasons: string[];
  rating: number | null;
  /** Perishable catalogue ingredients (pantry staples excluded). */
  ingredientIds: string[];
  /** Weeks since it was last planned, null if never. */
  weeksSinceEaten: number | null;
  /** Ingredients on sale this week (phase 3). */
  dealCount?: number;
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

/** Portions to cook per supper: everyone at supper, plus the lunches spread over the week. */
export function portionsPerRecipe(suppers: number, people: number, lunches: number): number[] {
  if (suppers <= 0) return [];
  const base = Math.floor(lunches / suppers);
  const extra = lunches % suppers;
  return Array.from({ length: suppers }, (_, i) => people + base + (i < extra ? 1 : 0));
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
  if (r.rating) s += (r.rating - 3) * 0.4;
  if (r.weeksSinceEaten === null) s += 0.3; // not planned yet
  else s += Math.min(r.weeksSinceEaten, 12) * 0.05; // long time no see
  s += (r.dealCount ?? 0) * 0.5;
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
export function suggest(
  recipes: PlannerRecipe[],
  count: number,
  rules: Rules,
  season: Season,
  opts: { keep?: string[]; avoid?: string[]; random?: () => number } = {},
): string[] {
  const random = opts.random ?? Math.random;
  const byId = new Map(recipes.map((r) => [r.id, r]));
  const picked = (opts.keep ?? []).map((id) => byId.get(id)).filter((r): r is PlannerRecipe => !!r);
  const taken = new Set([...picked.map((r) => r.id), ...(opts.avoid ?? [])]);

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
  opts: { avoid?: string[]; random?: () => number } = {},
): string | null {
  const others = current.filter((id) => id !== replaceId);
  const result = suggest(recipes, others.length + 1, rules, season, {
    keep: others,
    avoid: [replaceId, ...(opts.avoid ?? [])],
    random: opts.random,
  });
  return result.length > others.length ? result[result.length - 1] : null;
}
