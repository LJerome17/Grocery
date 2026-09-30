// Validation of the grocery list: every week's list is compared with an expected list computed
// independently here (group by catalogue item, convert to g / ml / count, multiply, add low and high ends,
// convert to the buying unit, round whole units up). Read-only on the app: nothing in src/lib is changed.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({ inserted: [] as Record<string, unknown>[] }));
vi.mock("../lib/supabase", () => {
  const chain = (): Record<string, unknown> => {
    const p: Record<string, unknown> = {};
    p.select = () => p;
    p.eq = () => p;
    p.delete = () => p;
    p.insert = (rows: Record<string, unknown>[]) => {
      mockState.inserted.push(...rows);
      return p;
    };
    p.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res, rej);
    return p;
  };
  return { supabase: () => ({ from: () => chain() }), SUPABASE_URL: "http://test", SUPABASE_KEY: "test" };
});

import { buildShoppingList, type CatalogItem, type Equiv, type ListIngredient, type ListLine } from "../lib/shopping";
import { setLang } from "../lib/i18n";
import { UNIT_BY_KEY, UNITS } from "../lib/units";
import { generateList } from "../lib/weekPlan";
import type { Ingredient, Recipe, RecipeIngredient, WeekPlanRecipe } from "../lib/db";

// ---------------------------------------------------------------- data

const ROOT = join(__dirname, "..", "..");
type CatEntry = { name: string; name_en: string; aisle: string; pantry?: boolean; count_unit?: string; equiv?: Equiv; ml_per_can?: number; cooked_ratio?: number };
type SIng = { raw: string; quantity: number | null; quantity_max: number | null; unit: string | null; name: string; optional: boolean; catalog: string | null };
type SRecipe = { title: string; ingredients: SIng[] };

const CAT: CatEntry[] = JSON.parse(readFileSync(join(ROOT, "data", "catalog.json"), "utf8")).ingredients;
const RECIPES: SRecipe[] = JSON.parse(readFileSync(join(ROOT, "public", "starter", "recipes.json"), "utf8"));
const CAT_BY_NAME = new Map(CAT.map((c) => [c.name, c]));
const catalog = new Map<string, CatalogItem>(
  // ml_per_can and cooked_ratio (added 2026-09-30) are passed too, so the list is the one the app really shows.
  CAT.map((c) => [c.name, { id: c.name, name: c.name, name_en: c.name_en, aisle: c.aisle, pantry: !!c.pantry, count_unit: c.count_unit ?? null, equiv: c.equiv ?? null, ml_per_can: c.ml_per_can ?? null, cooked_ratio: c.cooked_ratio ?? null }]),
);
const byTitle = (t: string) => {
  const r = RECIPES.find((x) => x.title === t);
  if (!r) throw new Error(`recette introuvable : ${t}`);
  return r;
};

type WeekItem = { recipe: SRecipe; factor: number };
type Week = { name: string; items: WeekItem[] };

const toApp = (w: Week) =>
  w.items.map(({ recipe, factor }) => ({
    title: recipe.title,
    factor,
    ingredients: recipe.ingredients.map((i): ListIngredient => ({ quantity: i.quantity, quantity_max: i.quantity_max, unit: i.unit, name: i.name, optional: i.optional, ingredient_id: i.catalog })),
  }));

// ---------------------------------------------------------------- independent reference

const NEGLIGIBLE = new Set(["pinch", "sprig", "handful", "drizzle"]); // documented in shopping.ts: "too small to matter"
// Cooked grains (2026-09-30): an ingredient NAME saying cooked is bought dry, divided by the catalogue cooked_ratio.
const COOKED = /\b(?:cuits?|cuites?|cooked)\b/i;
const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

type Expected = {
  key: string;
  label: string;
  labelEn: string;
  aisle: string;
  pantry: boolean;
  optional: boolean;
  recipes: string[];
  base: Map<string, [number, number]>; // g / ml / count unit (before buying-unit conversion)
  buying: Map<string, [number, number]>; // after buying-unit conversion
  unquantified: boolean;
  droppedNegligible: string[]; // e.g. "2-3 handful" lines not added up
};

function reference(w: Week): Map<string, Expected> {
  const out = new Map<string, Expected>();
  for (const { recipe, factor } of w.items) {
    for (const i of recipe.ingredients) {
      const c = i.catalog ? CAT_BY_NAME.get(i.catalog) : undefined;
      if (c?.aisle === "aucun") continue; // water is never bought
      const key = c ? c.name : `nom:${norm(i.name)}`;
      let e = out.get(key);
      if (!e) {
        e = { key, label: c?.name ?? i.name, labelEn: c?.name_en ?? i.name, aisle: c?.aisle ?? "autre", pantry: !!c?.pantry, optional: true, recipes: [], base: new Map(), buying: new Map(), unquantified: false, droppedNegligible: [] };
        out.set(key, e);
      }
      if (!e.recipes.includes(recipe.title)) e.recipes.push(recipe.title);
      if (!i.optional) e.optional = false;
      if (i.quantity === null || i.quantity === 0) {
        e.unquantified = true;
        continue;
      }
      if (i.unit && NEGLIGIBLE.has(i.unit)) {
        e.unquantified = true;
        e.droppedNegligible.push(`${recipe.title}: ${i.raw}`);
        continue;
      }
      let unit = i.unit;
      if ((unit === null || unit === "piece") && c?.count_unit) unit = c.count_unit; // "2 ail" = 2 gousses
      let base = unit ?? "";
      let k = 1;
      const def = unit ? UNIT_BY_KEY[unit] : undefined;
      if (def?.dim === "mass") [base, k] = ["g", def.factor];
      else if (def?.dim === "volume") [base, k] = ["ml", def.factor];
      if (c?.cooked_ratio && COOKED.test(i.name)) k /= c.cooked_ratio;
      const lo = i.quantity * factor * k;
      const hi = Math.max(i.quantity, i.quantity_max ?? i.quantity) * factor * k;
      const p = e.base.get(base) ?? [0, 0];
      e.base.set(base, [p[0] + lo, p[1] + hi]);
    }
  }
  for (const e of out.values()) {
    const eq = CAT_BY_NAME.get(e.key)?.equiv;
    for (const [u, [lo, hi]] of e.base) {
      let target = u, k = 1;
      if (eq) {
        if (u === eq.unit) k = 1;
        else if (u === "ml" && typeof eq.ml === "number") [target, k] = [eq.unit, 1 / eq.ml];
        else if (u === "g" && typeof eq.g === "number") [target, k] = [eq.unit, 1 / eq.g];
        else if (typeof eq[u] === "number") [target, k] = [eq.unit, eq[u] as number];
      }
      const p = e.buying.get(target) ?? [0, 0];
      e.buying.set(target, [p[0] + lo * k, p[1] + hi * k]);
    }
  }
  return out;
}

// ---------------------------------------------------------------- parse the app's text back into numbers

const FRAC: Record<string, number> = { "¼": 0.25, "½": 0.5, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3 };
const EN_LABELS: Record<string, [string, string]> = {
  tsp: ["tsp", "tsp"], tbsp: ["tbsp", "tbsp"], cup: ["cup", "cups"], floz: ["fl oz", "fl oz"], can: ["can", "cans"], pack: ["pack", "packs"], carton: ["carton", "cartons"],
  punnet: ["container", "containers"], portion: ["serving", "servings"], sheet: ["sheet", "sheets"], ball: ["ball", "balls"], head: ["head", "heads"], drizzle: ["drizzle", "drizzles"],
  clove: ["clove", "cloves"], stalk: ["stalk", "stalks"], bunch: ["bunch", "bunches"], pinch: ["pinch", "pinches"], handful: ["handful", "handfuls"], slice: ["slice", "slices"],
  sprig: ["sprig", "sprigs"], cube: ["cube", "cubes"], block: ["block", "blocks"], piece: ["piece", "pieces"], inch: ["inch", "inches"],
};
function labelMap(lang: "fr" | "en"): Map<string, [string, number]> {
  const m = new Map<string, [string, number]>([["g", ["g", 1]], ["kg", ["g", 1000]], ["ml", ["ml", 1]], ["L", ["ml", 1000]]]);
  for (const u of UNITS) if (u.dim === "count") for (const l of lang === "en" ? EN_LABELS[u.key] ?? u.label : u.label) m.set(l, [u.key, 1]);
  return m;
}
const LABELS = { fr: labelMap("fr"), en: labelMap("en") };

function parseNumber(s: string, lang: "fr" | "en"): number {
  const m = s.match(/^(\d+(?:[.,]\d+)?)?\s?([¼½¾⅓⅔])?$/);
  if (!m || (!m[1] && !m[2])) throw new Error(`nombre illisible « ${s} »`);
  if (m[1] && m[1].includes(lang === "fr" ? "." : ",")) throw new Error(`séparateur décimal inattendu « ${s} » (${lang})`);
  return (m[1] ? Number(m[1].replace(",", ".")) : 0) + (m[2] ? FRAC[m[2]] : 0);
}
function parseSide(s: string, lang: "fr" | "en"): { value: number; unit: string | null; mult: number } {
  const m = s.trim().match(/^([\d.,]+(?:\s[¼½¾⅓⅔])?|[¼½¾⅓⅔])(?:\s(.+))?$/);
  if (!m) throw new Error(`quantité illisible « ${s} »`);
  const value = parseNumber(m[1], lang);
  if (!m[2]) return { value, unit: null, mult: 1 };
  const u = LABELS[lang].get(m[2]);
  if (!u) throw new Error(`unité inconnue « ${m[2]} » dans « ${s} »`);
  return { value, unit: u[0], mult: u[1] };
}
/** "1,5 à 2 kg + 3 boîtes (540 ml)" -> { g: [1500, 2000], can: [3, 3] }; also returns the displayed unit per part
 *  and the can size shown after a can count (2026-09-30). */
function parseQuantity(text: string, lang: "fr" | "en"): Map<string, { lo: number; hi: number; big: boolean; canMl?: number }> {
  const out = new Map<string, { lo: number; hi: number; big: boolean; canMl?: number }>();
  for (let part of text.split(" + ")) {
    const size = part.match(/ \((\d+) ml\)$/);
    if (size) part = part.slice(0, -size[0].length);
    const sides = part.split(lang === "fr" ? " à " : " to ");
    if (sides.length > 2) throw new Error(`plage illisible « ${part} »`);
    const right = parseSide(sides[sides.length - 1], lang);
    const left = sides.length === 2 ? parseSide(sides[0], lang) : right;
    const unit = right.unit ?? "";
    const lu = left.unit ?? right.unit ?? "", lm = left.unit ? left.mult : right.mult;
    if (lu !== unit) throw new Error(`deux unités dans une plage « ${part} »`);
    if (out.has(unit)) throw new Error(`unité répétée « ${text} »`);
    if (size && unit !== "can") throw new Error(`format de boîte hors d'une boîte « ${text} »`);
    out.set(unit, { lo: left.value * lm, hi: right.value * right.mult, big: right.mult > 1, ...(size ? { canMl: Number(size[1]) } : {}) });
  }
  return out;
}

// ---------------------------------------------------------------- comparison

const WHOLE = new Set(["", "can", "pack", "carton", "punnet", "portion", "sheet", "ball", "block", "bunch", "clove", "stalk", "piece", "cube", "slice", "inch", "head"]);
const notes = { shortRounding: new Set<string>(), mixedUnits: new Set<string>(), negligibleDropped: new Set<string>(), unquantifiedHidden: new Set<string>() };

function checkAmount(where: string, unit: string, exp: number, got: number) {
  if (unit === "g" || unit === "ml") {
    const tol = exp >= 999.5 ? 50 : 0.5; // Math.round below 1000; ¼/⅓/½ or one decimal of kg / L above
    expect(Math.abs(got - exp), `${where}: ${got} ${unit} affiché, ${exp.toFixed(2)} attendu`).toBeLessThanOrEqual(tol + 1e-6);
  } else if (WHOLE.has(unit)) {
    const up = Math.max(1, Math.ceil(exp - 1e-9));
    // Documented: whole units rounded up. The app tolerates 0.1 unit above a whole number (float noise, 454 g / 450 g).
    const ok = got === up || (got === Math.max(1, Math.ceil(exp - 0.1)) && exp - got <= 0.1 + 1e-9);
    expect(ok, `${where}: ${got} ${unit || "(unités)"} affiché, ${exp.toFixed(3)} attendu (arrondi à ${up})`).toBe(true);
    if (got < exp - 1e-9) notes.shortRounding.add(`${where}: ${exp.toFixed(3)} -> ${got}`);
  } else {
    expect(Math.abs(got - exp), `${where}: ${got} ${unit} vs ${exp}`).toBeLessThanOrEqual(0.05 * Math.max(1, exp));
  }
}

function compareWeek(w: Week, lang: "fr" | "en" = "fr") {
  setLang(lang);
  let lines: ListLine[];
  try {
    lines = buildShoppingList(toApp(w), catalog);
  } finally {
    setLang("fr");
  }
  const exp = reference(w);
  // Exactly one line per catalogue item (or per unmatched name); none lost, none added, water absent.
  const keyOf = (l: ListLine) => l.ingredientId ?? `nom:${norm(l.label)}`;
  const keys = lines.map(keyOf);
  expect(new Set(keys).size, `${w.name}: lignes en double ${keys.filter((k, i) => keys.indexOf(k) !== i)}`).toBe(keys.length);
  expect([...keys].sort(), `${w.name}: articles`).toEqual([...exp.keys()].sort());
  for (const l of lines) {
    const e = exp.get(keyOf(l))!;
    const where = `${w.name} / ${e.label}`;
    expect(l.label, where).toBe(lang === "en" ? e.labelEn : e.label);
    expect(l.aisle, `${where}: rayon`).toBe(e.aisle);
    expect(l.pantry, `${where}: garde-manger`).toBe(e.pantry);
    expect(l.optional, `${where}: facultatif`).toBe(e.optional);
    expect(l.recipes, `${where}: recettes`).toEqual(e.recipes);
    expect(l.quantityText, where).not.toMatch(/NaN|undefined|Infinity|null|-\d/);
    if (e.buying.size === 0) {
      expect(l.quantityText, `${where}: sans quantité`).toBe(lang === "en" ? "as needed" : "au besoin");
      continue;
    }
    if (e.unquantified) notes.unquantifiedHidden.add(e.label);
    if (e.droppedNegligible.length) for (const d of e.droppedNegligible) notes.negligibleDropped.add(`${e.label} <- ${d}`);
    const got = parseQuantity(l.quantityText, lang);
    expect([...got.keys()].sort(), `${where}: unités « ${l.quantityText} »`).toEqual([...e.buying.keys()].sort());
    if (got.size > 1) notes.mixedUnits.add(`${e.label}: ${l.quantityText}`);
    for (const [u, [lo, hi]] of e.buying) {
      const g = got.get(u)!;
      // A can count shows the can size exactly when the catalogue has one: "2 boîtes (540 ml)".
      expect(g.canMl, `${where}: format de boîte « ${l.quantityText} »`).toBe(u === "can" ? CAT_BY_NAME.get(e.key)?.ml_per_can : undefined);
      checkAmount(`${where} (bas)`, u, lo, g.lo);
      checkAmount(`${where} (haut)`, u, hi, g.hi);
    }
  }
  return lines;
}

// ---------------------------------------------------------------- weeks

function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const synth = (title: string, ings: Partial<SIng>[]): SRecipe => ({
  title,
  ingredients: ings.map((i) => ({ raw: i.raw ?? i.name ?? "", quantity: null, quantity_max: null, unit: null, name: "", optional: false, catalog: null, ...i })),
});

const HAND: Week[] = [
  { name: "3 recettes de tofu (ferme / extra-ferme)", items: [{ recipe: byTitle("Tofu Magique Bang Bang"), factor: 1 }, { recipe: byTitle("One Pot Marry Me Tofu Recipe"), factor: 1 }, { recipe: byTitle("Bol quinoa, tofu et arachides"), factor: 1 }] },
  { name: "tofu en g et en blocs", items: [{ recipe: byTitle("Palak tofu"), factor: 1 }, { recipe: byTitle("Garlic Chili"), factor: 1 }, { recipe: byTitle("Tofu Magique"), factor: 1 }, { recipe: byTitle("Pain plat d'été au tofu crémeux façon burrata"), factor: 1 }] },
  { name: "ail, oignon, bouillon partagés", items: [{ recipe: byTitle("Potage à la courge musquée"), factor: 1 }, { recipe: byTitle("Bol de tofu katsu"), factor: 1 }, { recipe: byTitle("Marry Me Chickpeas"), factor: 1 }, { recipe: byTitle("Pâté chinois"), factor: 1 }] },
  { name: "recette ×2 et ×3", items: [{ recipe: byTitle("Vegan Jamaican Lentil Curry"), factor: 2 }, { recipe: byTitle("Cari végétarien au chou-fleur et patates douces"), factor: 3 }] },
  { name: "plages (œufs, ail, lait, bok choy)", items: [{ recipe: byTitle("Soupe ramen maison végé (de tes rêves!)"), factor: 1 }, { recipe: byTitle("Boulettes végé à la suédoise"), factor: 1 }, { recipe: byTitle("Lasagne au pesto, petits pois et courgette"), factor: 1 }, { recipe: byTitle("Soupe cari arachides avec oeuf mollet"), factor: 1 }] },
  { name: "plages ×3", items: [{ recipe: byTitle("Soupe ramen maison végé (de tes rêves!)"), factor: 3 }, { recipe: byTitle("Garlic Chili"), factor: 2 }] },
  { name: "facultatif ici, obligatoire là", items: [{ recipe: byTitle("Tofu Magique Bang Bang"), factor: 1 }, { recipe: byTitle("Pâté chinois"), factor: 1 }, { recipe: byTitle("Bol de tofu shawarma au houmous"), factor: 1 }, { recipe: byTitle("Salade de couscous perlé aux légumes rôtis et tomates séchées"), factor: 1 }] },
  { name: "garde-manger et épices", items: [{ recipe: byTitle("Vegetarian Moussaka"), factor: 1 }, { recipe: byTitle("Dhal de lentilles au curcuma et lait de coco avec pleurotes au paprika fumé"), factor: 1 }, { recipe: byTitle("Cari de tempeh"), factor: 1 }] },
  {
    name: "lignes non reconnues + eau",
    items: [
      { recipe: byTitle("Massaged Kale Salad"), factor: 1 },
      {
        recipe: synth("Recette test non reconnue", [
          { name: "Sauce secrète de grand-mère", quantity: 2, unit: "tbsp" },
          { name: "sauce secrete de grand mere", quantity: 1, unit: "tsp" },
          { name: "Épice mystère", quantity: null, optional: true },
          { name: "Eau", quantity: 2, unit: "cup", catalog: "Eau" },
          { name: "Gousses d'ail", quantity: 3, unit: null, catalog: "Ail" },
          { name: "Ail", quantity: 1, unit: "head", catalog: "Ail" },
        ]),
        factor: 2,
      },
    ],
  },
  {
    name: "équivalences d'unités (ml/g/têtes/cubes -> unité d'achat)",
    items: [
      {
        recipe: synth("Équivalences", [
          { name: "oignon haché", quantity: 1, unit: "cup", catalog: "Oignon jaune" },
          { name: "oignon", quantity: 1, catalog: "Oignon jaune" },
          { name: "pois chiches", quantity: 250, unit: "ml", catalog: "Pois chiches (conserve)" },
          { name: "pois chiches", quantity: 1, unit: "can", catalog: "Pois chiches (conserve)" },
          { name: "bouillon", quantity: 2, unit: "cube", catalog: "Bouillon de légumes" },
          { name: "bouillon", quantity: 1, unit: "l", catalog: "Bouillon de légumes" },
          { name: "épinards", quantity: 1, unit: "bunch", catalog: "Épinards" },
          { name: "épinards", quantity: 2, unit: "cup", catalog: "Épinards" },
          { name: "gingembre", quantity: 1, unit: "tbsp", catalog: "Gingembre" },
          { name: "gingembre", quantity: 1, unit: "piece", catalog: "Gingembre" },
          { name: "tofu", quantity: 225, unit: "g", catalog: "Tofu ferme" },
          { name: "tofu", quantity: 1, unit: "pack", catalog: "Tofu ferme" },
        ]),
        factor: 3,
      },
    ],
  },
  { name: "multiplicateur ×3 sur ail en tête", items: [{ recipe: synth("Tête d'ail", [{ name: "ail", quantity: 0.5, unit: "head", catalog: "Ail" }, { name: "ail", quantity: 2, unit: "clove", catalog: "Ail" }]), factor: 3 }] },
];

const RANDOM: Week[] = [];
{
  const rand = rng(20260930);
  for (let w = 0; w < 36; w++) {
    const n = 2 + Math.floor(rand() * 5);
    const picked = new Set<number>();
    while (picked.size < n) picked.add(Math.floor(rand() * RECIPES.length));
    RANDOM.push({ name: `aléatoire #${w + 1}`, items: [...picked].map((k) => ({ recipe: RECIPES[k], factor: 1 + Math.floor(rand() * 3) })) });
  }
}

afterEach(() => setLang("fr"));
afterAll(() => {
  const show = (t: string, s: Set<string>) => console.log(`\n[${t}] ${s.size}\n  ${[...s].slice(0, 40).join("\n  ")}`);
  show("arrondi sous le besoin (tolérance 0,1)", notes.shortRounding);
  show("unités mélangées sur une ligne", notes.mixedUnits);
  show("poignée/pincée/brin/filet non additionnés alors qu'il y a un total", notes.negligibleDropped);
  show("« au besoin » masqué par une autre quantité", notes.unquantifiedHidden);
});

// ---------------------------------------------------------------- tests

describe("semaines choisies à la main", () => {
  for (const w of HAND) it(w.name, () => void compareWeek(w));
});

describe(`semaines aléatoires (${RANDOM.length}, graine fixe)`, () => {
  for (const w of RANDOM) it(w.name, () => void compareWeek(w));
});

describe("chaque recette seule ×1, ×2, ×3 (référence indépendante)", () => {
  for (const f of [1, 2, 3]) it(`69 recettes ×${f}`, () => {
    for (const r of RECIPES) compareWeek({ name: `${r.title} ×${f}`, items: [{ recipe: r, factor: f }] });
  });
});

describe("règles précises", () => {
  it("tofu ferme et extra-ferme restent deux articles, en blocs", () => {
    const lines = compareWeek(HAND[0]);
    const tofu = lines.filter((l) => l.label.startsWith("Tofu"));
    expect(tofu.map((l) => [l.label, l.quantityText])).toEqual([["Tofu extra-ferme", "2 blocs"], ["Tofu ferme", "2 blocs"]]);
  });
  it("×2 et ×3 : le multiplicateur est appliqué exactement (lait de coco, bouillon)", () => {
    const one = buildShoppingList(toApp({ name: "", items: [{ recipe: byTitle("Vegan Jamaican Lentil Curry"), factor: 1 }] }), catalog);
    const three = buildShoppingList(toApp({ name: "", items: [{ recipe: byTitle("Vegan Jamaican Lentil Curry"), factor: 3 }] }), catalog);
    const q = (ls: ListLine[], n: string) => ls.find((l) => l.label === n)?.quantityText;
    // Can size shown after the count since 2026-09-30.
    expect(q(one, "Lait de coco")).toBe("1 boîte (400 ml)"); // 1 tasse = 250 ml = 0,625 boîte de 400 ml
    expect(q(three, "Lait de coco")).toBe("2 boîtes (400 ml)"); // 750 ml = 1,875 boîte -> 2
    const tempeh3 = buildShoppingList(toApp({ name: "", items: [{ recipe: byTitle("Cari de tempeh"), factor: 3 }] }), catalog);
    expect(q(tempeh3, "Lait de coco")).toBe("3 boîtes (400 ml)"); // 1 boîte ×3
    compareWeek(HAND[3]);
  });
  it("les plages restent « a à b » et le haut est additionné séparément", () => {
    const lines = compareWeek(HAND[4]);
    expect(lines.find((l) => l.label === "Œufs")?.quantityText).toMatch(/^\d+ à \d+$/);
  });
  it("facultatif seulement si facultatif partout", () => {
    const lines = compareWeek(HAND[6]);
    for (const l of lines) {
      const uses = HAND[6].items.flatMap(({ recipe }) => recipe.ingredients.filter((i) => i.catalog === l.ingredientId));
      expect(l.optional, l.label).toBe(uses.every((i) => i.optional));
    }
    expect(lines.filter((l) => l.optional).length).toBeGreaterThan(0);
  });
  it("lignes non reconnues : regroupées par nom, rayon « autre », jamais au garde-manger ; eau absente", () => {
    const lines = compareWeek(HAND[8]);
    const secret = lines.filter((l) => l.ingredientId === null && /secr/i.test(l.label));
    expect(secret).toHaveLength(1);
    expect(secret[0].quantityText).toBe("70 ml"); // (2 c. à soupe + 1 c. à thé) × 2
    expect(secret[0].aisle).toBe("autre");
    expect(lines.find((l) => l.label === "Épice mystère")).toMatchObject({ quantityText: "au besoin", optional: true, pantry: false });
  });
  it("ail : 1 tête + 3 gousses ×2 = 26 gousses", () => {
    const lines = compareWeek(HAND[8]);
    expect(lines.find((l) => l.label === "Ail")?.quantityText).toBe("26 gousses");
  });
  it("lignes sans quantité : « au besoin », jamais un nombre", () => {
    for (const r of RECIPES) {
      const lines = buildShoppingList(toApp({ name: "", items: [{ recipe: r, factor: 3 }] }), catalog);
      for (const l of lines) {
        const quantified = r.ingredients.some((i) => i.catalog === l.ingredientId && i.quantity && !(i.unit && NEGLIGIBLE.has(i.unit)));
        if (!quantified) expect(l.quantityText, `${r.title} / ${l.label}`).toBe("au besoin");
      }
    }
  });
  // Fixed 2026-09-30: a non-zero trace shows at least "1 g" / "1 ml", never "0 g" / "0 ml" (20 mg of saffron,
  // 1/16 c. à thé of nutmeg). A quantity of 0 is still "au besoin".
  it("une quantité minuscule ne donne jamais « 0 g » / « 0 ml »", () => {
    const w: Week = { name: "minuscule", items: [{ recipe: synth("Minuscule", [{ name: "muscade", quantity: 0.05, unit: "tsp", catalog: "Muscade" }, { name: "sel", quantity: 0, unit: "tsp", catalog: "Sel" }, { name: "safran", quantity: 20, unit: "mg", catalog: null }]), factor: 1 }] };
    const lines = buildShoppingList(toApp(w), catalog);
    for (const l of lines) expect(l.quantityText, l.label).not.toMatch(/(^|[^\d,.])0( |$)/);
    const q = (n: string) => lines.find((l) => l.label === n)?.quantityText;
    expect(q("Muscade")).toBe("1 ml");
    expect(q("safran")).toBe("1 g");
    expect(q("Sel")).toBe("au besoin");
  });
});

describe("invariants sur les 69 recettes", () => {
  for (const f of [1, 3]) {
    for (const lang of ["fr", "en"] as const) {
      it(`toutes les recettes ensemble et une à une, ×${f}, ${lang}`, () => {
        const weeks: Week[] = [{ name: `tout ×${f}`, items: RECIPES.map((r) => ({ recipe: r, factor: f })) }, ...RECIPES.map((r) => ({ name: `${r.title} ×${f}`, items: [{ recipe: r, factor: f }] }))];
        for (const w of weeks) {
          setLang(lang);
          const lines = buildShoppingList(toApp(w), catalog);
          setLang("fr");
          for (const l of lines) {
            const where = `${w.name} / ${l.label}: « ${l.quantityText} »`;
            expect(l.quantityText, where).not.toMatch(/NaN|undefined|Infinity|null/);
            expect(l.quantityText, where).not.toMatch(/(^|[^\d.,])0( |$)|-\d/);
            expect(l.label, where).not.toMatch(/^Eau$|^Water$/);
            if (/au besoin|as needed/.test(l.quantityText)) continue;
            const q = parseQuantity(l.quantityText, lang);
            for (const [u, { lo, hi }] of q) {
              expect(lo, where).toBeGreaterThan(0);
              expect(hi, where).toBeGreaterThanOrEqual(lo);
              if (u === "g" || u === "ml") expect(hi, where).toBeLessThanOrEqual(50000);
            }
          }
        }
      });
    }
  }
});

describe("mode anglais", () => {
  const same = (w: Week) => {
    const fr = compareWeek(w, "fr");
    const en = compareWeek(w, "en");
    expect(en.length).toBe(fr.length);
    const enByKey = new Map(en.map((l) => [l.key, l]));
    for (const l of fr) {
      const e = enByKey.get(l.key)!;
      if (l.quantityText === "au besoin") expect(e.quantityText).toBe("as needed");
      else {
        const a = parseQuantity(l.quantityText, "fr"), b = parseQuantity(e.quantityText, "en");
        expect([...b.entries()].map(([u, v]) => [u, +v.lo.toFixed(3), +v.hi.toFixed(3)]), `${w.name} / ${e.label}`).toEqual([...a.entries()].map(([u, v]) => [u, +v.lo.toFixed(3), +v.hi.toFixed(3)]));
        expect(e.quantityText).not.toMatch(/ à |boîte|gousse|botte|tasse|bloc\b|feuille|au besoin/);
        if (/ à /.test(l.quantityText)) expect(e.quantityText).toMatch(/ to /);
      }
    }
  };
  for (const w of [...HAND, ...RANDOM.slice(0, 10)]) it(`mêmes nombres en anglais : ${w.name}`, () => same(w));

  // Fixed 2026-09-30: the regex that strips the number before comparing units now knows the decimal point, so
  // English writes "1.2 to 2.2 kg" (was "1 to 2.2 kg"), like French "1,2 à 2,2 kg".
  it("plage décimale en anglais : 1.2 to 2.2 kg", () => {
    const w: Week = { name: "plage décimale", items: [{ recipe: synth("Plage kg", [{ name: "farine", quantity: 1.2, quantity_max: 2.2, unit: "kg", catalog: "Farine tout usage" }]), factor: 1 }] };
    setLang("en");
    const t = buildShoppingList(toApp(w), catalog)[0].quantityText;
    setLang("fr");
    expect(t).toBe("1.2 to 2.2 kg");
  });
  it("même plage en français : 1,2 à 2,2 kg", () => {
    const w: Week = { name: "plage décimale", items: [{ recipe: synth("Plage kg", [{ name: "farine", quantity: 1.2, quantity_max: 2.2, unit: "kg", catalog: "Farine tout usage" }]), factor: 1 }] };
    expect(buildShoppingList(toApp(w), catalog)[0].quantityText).toBe("1,2 à 2,2 kg");
  });
});

describe("generateList (weekPlan) : lignes écrites dans la liste", () => {
  const run = async (w: Week, lang: "fr" | "en" = "fr") => {
    mockState.inserted.length = 0;
    const recipes = w.items.map(({ recipe }, k) => ({ id: `r${k}`, title: recipe.title }) as unknown as Recipe);
    const ings = w.items.flatMap(({ recipe }, k) => recipe.ingredients.map((i, p) => ({ id: `i${k}-${p}`, recipe_id: `r${k}`, position: p, section: null, raw: i.raw, quantity: i.quantity, quantity_max: i.quantity_max, unit: i.unit, name: i.name, note: null, optional: i.optional, ingredient_id: i.catalog }) as RecipeIngredient));
    const items = w.items.map(({ factor }, k) => ({ id: `w${k}`, plan_id: "p", recipe_id: `r${k}`, multiplier: factor, portions: 4 * factor, position: k, cooked: false }) as WeekPlanRecipe);
    const cat = CAT.map((c) => ({ id: c.name, household_id: null, name: c.name, name_en: c.name_en, aisle: c.aisle, pantry: !!c.pantry, count_unit: c.count_unit ?? null, equiv: c.equiv ?? null, ml_per_can: c.ml_per_can ?? null, cooked_ratio: c.cooked_ratio ?? null }) as Ingredient);
    setLang(lang);
    try {
      const n = await generateList("p", items, recipes, ings, cat);
      const direct = buildShoppingList(toApp(w), catalog);
      return { n, rows: [...mockState.inserted], direct };
    } finally {
      setLang("fr");
    }
  };
  for (const w of [HAND[6], HAND[8], RANDOM[0], RANDOM[1]]) {
    it(`mêmes lignes que buildShoppingList + « (facultatif) » : ${w.name}`, async () => {
      const exp = reference(w);
      const { n, rows, direct } = await run(w);
      expect(n).toBe(direct.length);
      expect(rows.map((r) => r.quantity_text)).toEqual(direct.map((l) => l.quantityText));
      for (const [k, r] of rows.entries()) {
        const e = exp.get(direct[k].ingredientId ?? `nom:${norm(direct[k].label)}`)!;
        expect(r.label).toBe(e.optional ? `${e.label} (facultatif)` : e.label);
        expect(r.pantry).toBe(e.pantry);
        expect(r.aisle).toBe(e.aisle);
      }
      expect(rows.some((r) => r.label === "Eau")).toBe(false);
    });
  }
  it("anglais : « (optional) » et noms anglais", async () => {
    const { rows } = await run(HAND[6], "en");
    expect(rows.some((r) => String(r.label).endsWith("(optional)"))).toBe(true);
    expect(rows.some((r) => String(r.label).includes("facultatif"))).toBe(false);
  });
});
