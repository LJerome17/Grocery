// Build the grocery list from the week's recipes: scale, convert, add up, sort by aisle.

import { AISLE_ORDER, NO_AISLE } from "./aisles";
import { nameKey } from "./text";
import { formatBase, formatNumber, toBase, UNIT_BY_KEY } from "./units";

export type ListIngredient = {
  quantity: number | null;
  /** Upper end of a range ("4-8 oeufs"): the list buys the upper end. */
  quantity_max?: number | null;
  unit: string | null;
  name: string;
  optional: boolean;
  ingredient_id: string | null;
};

export type CatalogItem = {
  id: string;
  name: string;
  aisle: string;
  pantry: boolean;
  /** Unit implied by a bare number in a recipe ("2 ail" = 2 cloves, "1 gingembre" = 1 inch). */
  count_unit?: string | null;
  /** How to add up different units of this product in the unit it is bought in. */
  equiv?: Equiv | null;
};

/**
 * `unit`: the buying unit ("" = counted as is, "g"/"ml" = weighed/measured, else a count unit key).
 * `ml` / `g`: how many millilitres / grams one buying unit represents.
 * Other keys (count units): how many buying units one of that unit represents (Ail: head = 10 cloves).
 */
export type Equiv = { unit: string; ml?: number; g?: number; [countUnit: string]: number | string | undefined };

/** Convert every amount it can into the buying unit; the rest stays as is. */
function toBuyingUnit(amounts: Map<string, [number, number]>, e: Equiv): Map<string, [number, number]> {
  const out = new Map<string, [number, number]>();
  const add = (u: string, [lo, hi]: [number, number], k: number) => {
    const p = out.get(u) ?? [0, 0];
    out.set(u, [p[0] + lo * k, p[1] + hi * k]);
  };
  for (const [u, v] of amounts) {
    if (u === e.unit) add(u, v, 1);
    else if (u === "ml" && typeof e.ml === "number") add(e.unit, v, 1 / e.ml);
    else if (u === "g" && typeof e.g === "number") add(e.unit, v, 1 / e.g);
    else if (typeof e[u] === "number") add(e.unit, v, e[u] as number);
    else add(u, v, 1);
  }
  return out;
}

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
const WHOLE_UNITS = new Set(["", "can", "pack", "carton", "punnet", "portion", "sheet", "ball", "block", "bunch", "clove", "stalk", "piece", "cube", "slice", "inch", "head"]);
/** Units too small to matter on a shopping list. */
const NEGLIGIBLE_UNITS = new Set(["pinch", "sprig", "handful", "drizzle"]);

/** [low, high] of a quantity: equal unless a recipe gives a range ("4-8 oeufs"). */
type Range = [number, number];

type Acc = {
  line: ListLine;
  equiv: Equiv | null;
  amounts: Map<string, Range>; // base unit -> amount
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
          equiv: cat?.equiv ?? null,
          amounts: new Map(),
          unquantified: false,
          requiredSomewhere: false,
        };
        acc.set(key, a);
      }
      if (!a.line.recipes.includes(r.title)) a.line.recipes.push(r.title);
      if (!i.optional) a.requiredSomewhere = true;
      if (i.quantity === null || i.quantity === 0 || (i.unit && NEGLIGIBLE_UNITS.has(i.unit))) {
        a.unquantified = true;
        continue;
      }
      const unit = (i.unit === null || i.unit === "piece") && cat?.count_unit ? cat.count_unit : i.unit;
      // Ranges are kept as written: "4-8 oeufs" stays "4 à 8" on the list (low and high are added up separately).
      const low = toBase(i.quantity * r.factor, unit);
      const high = toBase(Math.max(i.quantity, i.quantity_max ?? 0) * r.factor, unit);
      const prev = a.amounts.get(low.baseUnit) ?? [0, 0];
      a.amounts.set(low.baseUnit, [prev[0] + low.amount, prev[1] + high.amount]);
    }
  }

  const lines = [...acc.values()].map(({ line, equiv, amounts, unquantified, requiredSomewhere }) => {
    const buying = equiv ? toBuyingUnit(amounts, equiv) : amounts;
    const parts = [...buying.entries()].map(([unit, [low, high]]) => {
      if (WHOLE_UNITS.has(unit)) [low, high] = [low, high].map((v) => Math.max(1, Math.ceil(v - 0.1))) as Range;
      const one = (v: number) => (unit === "" ? formatNumber(v) : formatBase(v, unit));
      if (Math.abs(high - low) < 1e-9 || one(low) === one(high)) return one(low);
      // "4 à 8", "250 à 375 ml": the unit is written once when both ends share it.
      const [a, b] = [one(low), one(high)];
      const unitA = a.replace(/^[\d\s,¼½¾⅓⅔]+/, ""), unitB = b.replace(/^[\d\s,¼½¾⅓⅔]+/, "");
      return unitA && unitA === unitB ? `${a.slice(0, a.length - unitA.length).trim()} à ${b}` : `${a} à ${b}`;
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

/** Scaled quantity for display in a recipe ("1 ½ tasse"). */
export function scaledQuantity(quantity: number | null, quantityMax: number | null, unit: string | null, factor: number): string {
  if (quantity === null) return "";
  const q = formatNumber(quantity * factor);
  const max = quantityMax ? `–${formatNumber(quantityMax * factor)}` : "";
  const u = unit ? UNIT_BY_KEY[unit] : null;
  const label = u ? (quantity * factor > 1 ? u.label[1] : u.label[0]) : unit ?? "";
  return `${q}${max}${label ? ` ${label}` : ""}`;
}
