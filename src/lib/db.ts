// Row types of the Supabase tables (see supabase/migrations).

import type { Equiv } from "./shopping";
import { lang, type Lang } from "./i18n";
import { SUPABASE_URL } from "./supabase";

export type Household = {
  id: string;
  name: string;
  invite_code: string;
  max_same_dish_type: number;
  max_same_protein: number;
  repeat_cooldown_weeks: number;
  /** The Momo et Jéjé household: its recipes are the book every household reads (only it can change them). */
  is_book: boolean;
  /** Interface language of the household. */
  lang: Lang;
  /** Starter recipes already received (so a deleted one is never added back). */
  starter_seen: string[] | null;
};

export type Recipe = {
  id: string;
  household_id: string;
  title: string;
  source_type: "url" | "photo" | "pdf" | "manual";
  source_url: string | null;
  image_url: string | null;
  servings: number | null;
  total_minutes: number | null;
  instructions: string[];
  notes: string | null;
  dish_type: string | null;
  protein: string | null;
  seasons: string[];
  rating: number | null;
  active: boolean;
};

export type RecipeIngredient = {
  id: string;
  recipe_id: string;
  position: number;
  section: string | null;
  raw: string;
  quantity: number | null;
  quantity_max: number | null;
  unit: string | null;
  name: string;
  note: string | null;
  optional: boolean;
  ingredient_id: string | null;
};

export type Ingredient = {
  id: string;
  household_id: string | null;
  name: string;
  /** English grocery-list name (catalogue items; household items only have `name`). */
  name_en?: string | null;
  aisle: string;
  pantry: boolean;
  count_unit: string | null;
  /** Buying-unit equivalences (see Equiv in shopping.ts). */
  equiv: Equiv | null;
};

export type WeekPlan = {
  id: string;
  household_id: string;
  week_start: string;
  /** Maximum number of recipes wanted (the column predates the portions model). */
  suppers: number;
  /** Portions wanted for the week. */
  portions: number;
  /** Seasons ticked for the suggestions (null = the current season). */
  seasons: string[] | null;
  exclude_dish_types: string[];
};

export type WeekPlanRecipe = {
  id: string;
  plan_id: string;
  recipe_id: string;
  /** Whole number: the recipe is made ×1, ×2… (quantities never adapted otherwise). */
  multiplier: number;
  portions: number;
  position: number;
  cooked: boolean;
};

export type ShoppingItem = {
  id: string;
  plan_id: string;
  ingredient_id: string | null;
  label: string;
  quantity_text: string | null;
  aisle: string;
  pantry: boolean;
  manual: boolean;
  checked: boolean;
  position: number;
};

export const RECIPE_COLUMNS =
  "id,household_id,title,source_type,source_url,image_url,servings,total_minutes,instructions,notes,dish_type,protein,seasons,rating,active";

export const DISH_TYPES = [
  "bol", "salade", "soupe", "ramen", "nouilles", "pâtes", "riz", "mijoté", "four", "plaque", "grillades", "wrap",
  "sandwich", "pain plat", "accompagnement",
];
export const PROTEINS = [
  "tofu", "tempeh", "pois chiches", "haricots noirs", "haricots rouges", "haricots blancs", "lentilles", "édamames",
  "haché végé", "fromage", "œufs", "végé", "poisson", "poulet",
];

/** Grocery-list name of a catalogue item in the household's language. */
export function catalogName(c: { name: string; name_en?: string | null }): string {
  return (lang() === "en" && c.name_en) || c.name;
}

const DISH_EN: Record<string, string> = {
  bol: "bowl", salade: "salad", soupe: "soup", ramen: "ramen", nouilles: "noodles", "pâtes": "pasta", riz: "rice",
  "mijoté": "stew", four: "oven-baked", plaque: "sheet pan", grillades: "grilled", wrap: "wrap", sandwich: "sandwich",
  "pain plat": "flatbread", accompagnement: "side dish",
};
const PROTEIN_EN: Record<string, string> = {
  tofu: "tofu", tempeh: "tempeh", "pois chiches": "chickpeas", "haricots noirs": "black beans", "haricots rouges": "red beans",
  "haricots blancs": "white beans", lentilles: "lentils", "édamames": "edamame", "haché végé": "veggie ground round",
  fromage: "cheese", "œufs": "eggs", "végé": "veggie", poisson: "fish", poulet: "chicken",
};

/** Dish type / protein as shown (the French word is the stored key). */
export function dishTypeLabel(key: string): string {
  return lang() === "en" ? DISH_EN[key] ?? key : key;
}
export function proteinLabel(key: string): string {
  return lang() === "en" ? PROTEIN_EN[key] ?? key : key;
}

/** image_url is a web URL, a site path (/starter/...) or "storage:<bucket>/<path>". */
export function imageSrc(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith("storage:")) return `${SUPABASE_URL}/storage/v1/object/public/${url.slice("storage:".length)}`;
  return url;
}
