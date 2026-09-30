// Row types of the Supabase tables (see supabase/migrations).

import { SUPABASE_URL } from "./supabase";

export type Household = {
  id: string;
  name: string;
  invite_code: string;
  max_same_dish_type: number;
  max_same_protein: number;
  repeat_cooldown_weeks: number;
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
  aisle: string;
  pantry: boolean;
  count_unit: string | null;
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
export const PROTEINS = ["tofu", "tempeh", "légumineuses", "fromage", "œufs", "végé", "poisson", "poulet"];

/** image_url is a web URL, a site path (/starter/...) or "storage:<bucket>/<path>". */
export function imageSrc(url: string | null): string | null {
  if (!url) return null;
  if (url.startsWith("storage:")) return `${SUPABASE_URL}/storage/v1/object/public/${url.slice("storage:".length)}`;
  return url;
}
