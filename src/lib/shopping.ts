// Build the grocery list from the week's recipes: scale, convert, add up, sort by aisle.

import { AISLE_ORDER, NO_AISLE } from "./aisles";
import { nameKey } from "./text";
import { formatBase, formatNumber, toBase, UNIT_BY_KEY } from "./units";

export type ListIngredient = {
  quantity: number | null;
  unit: string | null;
  name: string;
  optional: boolean;
  ingredient_id: string | null;
};

export type CatalogItem = { id: string; name: string; aisle: string; pantry: boolean };

export type ListLine = {
  key: string;
  ingredientId: string | null;
  label: string;
  quantityText: string;
  aisle: string;
  pantry: boolean;
  optional: boolean;
  recipes: string[];
};

/** Units bought whole: 1.3 cans means buying 2. */
const WHOLE_UNITS = new Set(["", "can", "pack", "block", "bunch", "clove", "stalk", "piece", "cube", "slice"]);
/** Units too small to matter on a shopping list. */
const NEGLIGIBLE_UNITS = new Set(["pinch", "sprig", "handful", "inch"]);

type Acc = {
  line: ListLine;
  amounts: Map<string, number>; // base unit -> amount
  unquantified: boolean;
  requiredSomewhere: boolean;
};

export function buildShoppingList(
  recipes: { title: string; factor: number; ingredients: ListIngredient[] }[],
  catalog: Map<string, CatalogItem>,
): ListLine[] {
  const acc = new Map<string, Acc>();
  for (const r of recipes) {
    for (const i of r.ingredients) {
      const cat = i.ingredient_id ? catalog.get(i.ingredient_id) : undefined;
      if (cat?.aisle === NO_AISLE) continue;
      const key = cat ? cat.id : `nom:${nameKey(i.name)}`;
      let a = acc.get(key);
      if (!a) {
        a = {
          line: {
            key,
            ingredientId: cat?.id ?? null,
            label: cat?.name ?? i.name,
            quantityText: "",
            aisle: cat?.aisle ?? "autre",
            pantry: cat?.pantry ?? false,
            optional: true,
            recipes: [],
          },
          amounts: new Map(),
          unquantified: false,
          requiredSomewhere: false,
        };
        acc.set(key, a);
      }
      if (!a.line.recipes.includes(r.title)) a.line.recipes.push(r.title);
      if (!i.optional) a.requiredSomewhere = true;
      if (i.quantity === null || (i.unit && NEGLIGIBLE_UNITS.has(i.unit))) {
        a.unquantified = true;
        continue;
      }
      const b = toBase(i.quantity * r.factor, i.unit);
      a.amounts.set(b.baseUnit, (a.amounts.get(b.baseUnit) ?? 0) + b.amount);
    }
  }

  const lines = [...acc.values()].map(({ line, amounts, unquantified, requiredSomewhere }) => {
    const parts = [...amounts.entries()].map(([unit, amount]) => {
      if (WHOLE_UNITS.has(unit)) amount = Math.max(1, Math.ceil(amount - 0.1));
      return unit === "" ? formatNumber(amount) : formatBase(amount, unit);
    });
    if (!parts.length && unquantified) parts.push("au besoin");
    return { ...line, quantityText: parts.join(" + "), optional: !requiredSomewhere };
  });

  return lines.sort(
    (a, b) =>
      Number(a.pantry) - Number(b.pantry) ||
      (AISLE_ORDER[a.aisle] ?? 99) - (AISLE_ORDER[b.aisle] ?? 99) ||
      a.label.localeCompare(b.label, "fr"),
  );
}

/** Scale factor for a recipe: portions wanted / portions it makes (4 when unknown). */
export function scaleFactor(portions: number, servings: number | null): number {
  return portions / (servings && servings > 0 ? servings : 4);
}

/** Scaled quantity for display in a recipe ("1 ½ tasse"). */
export function scaledQuantity(quantity: number | null, quantityMax: number | null, unit: string | null, factor: number): string {
  if (quantity === null) return "";
  const q = formatNumber(quantity * factor);
  const max = quantityMax ? `–${formatNumber(quantityMax * factor)}` : "";
  const u = unit ? UNIT_BY_KEY[unit] : null;
  const label = u ? (quantity * factor > 1 ? u.label[1] : u.label[0]) : unit ?? "";
  return `${q}${max}${label ? ` ${label}` : ""}`;
}
