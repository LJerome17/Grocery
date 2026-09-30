// Units: aliases (FR + EN), conversion to base units and French display labels.

export type Dim = "mass" | "volume" | "count";

export type UnitDef = {
  key: string;
  dim: Dim;
  /** Grams (mass) or millilitres (volume) per unit; 1 for count units. */
  factor: number;
  label: [singular: string, plural: string];
  aliases: string[];
};

// Aliases are written folded (lowercase, no accents). Longest match wins, so
// "c. a soupe" is tried before "c".
export const UNITS: UnitDef[] = [
  { key: "g", dim: "mass", factor: 1, label: ["g", "g"], aliases: ["g", "gr", "gram", "grams", "gramme", "grammes"] },
  { key: "kg", dim: "mass", factor: 1000, label: ["kg", "kg"], aliases: ["kg", "kgs", "kilo", "kilos", "kilogram", "kilograms", "kilogramme", "kilogrammes"] },
  { key: "mg", dim: "mass", factor: 0.001, label: ["mg", "mg"], aliases: ["mg"] },
  { key: "lb", dim: "mass", factor: 453.6, label: ["lb", "lb"], aliases: ["lb", "lbs", "pound", "pounds", "livre", "livres"] },
  { key: "oz", dim: "mass", factor: 28.35, label: ["oz", "oz"], aliases: ["oz", "ounce", "ounces", "once", "onces"] },
  { key: "ml", dim: "volume", factor: 1, label: ["ml", "ml"], aliases: ["ml", "millilitre", "millilitres", "milliliter", "milliliters"] },
  { key: "cl", dim: "volume", factor: 10, label: ["cl", "cl"], aliases: ["cl", "centilitre", "centilitres"] },
  { key: "l", dim: "volume", factor: 1000, label: ["L", "L"], aliases: ["l", "litre", "litres", "liter", "liters"] },
  { key: "tsp", dim: "volume", factor: 5, label: ["c. à thé", "c. à thé"], aliases: ["tsp", "tsps", "teaspoon", "teaspoons", "c. a the", "c.a.t", "c.a.t.", "cat", "c. a cafe", "c-a-the", "cuillere a the", "cuilleres a the", "cuillere a cafe", "cuilleres a cafe", "c. the", "c a the", "c a cafe"] },
  { key: "tbsp", dim: "volume", factor: 15, label: ["c. à soupe", "c. à soupe"], aliases: ["tbsp", "tbsps", "tbs", "tbl", "tbls", "tablespoon", "tablespoons", "c. a soupe", "c.a.s", "c.a.s.", "cas", "c. a table", "c-a-soupe", "cuillere a soupe", "cuilleres a soupe", "cuillere a table", "cuilleres a table", "c. soupe", "c a soupe", "c a table"] },
  { key: "cup", dim: "volume", factor: 250, label: ["tasse", "tasses"], aliases: ["cup", "cups", "tasse", "tasses", "c."] },
  { key: "floz", dim: "volume", factor: 29.57, label: ["oz liq.", "oz liq."], aliases: ["fl oz", "fl. oz", "fl.oz"] },
  { key: "can", dim: "count", factor: 1, label: ["boîte", "boîtes"], aliases: ["can", "cans", "tin", "tins", "boite", "boites", "conserve", "conserves", "canne", "cannes"] },
  { key: "pack", dim: "count", factor: 1, label: ["paquet", "paquets"], aliases: ["pack", "packs", "packet", "packets", "package", "packages", "paquet", "paquets", "sachet", "sachets", "bag", "bags", "sac", "sacs"] },
  { key: "clove", dim: "count", factor: 1, label: ["gousse", "gousses"], aliases: ["clove", "cloves", "gousse", "gousses"] },
  { key: "stalk", dim: "count", factor: 1, label: ["branche", "branches"], aliases: ["stalk", "stalks", "stick", "sticks", "rib", "ribs", "branche", "branches", "tige", "tiges"] },
  { key: "bunch", dim: "count", factor: 1, label: ["botte", "bottes"], aliases: ["bunch", "bunches", "botte", "bottes", "bouquet", "bouquets"] },
  { key: "pinch", dim: "count", factor: 1, label: ["pincée", "pincées"], aliases: ["pinch", "pinches", "pincee", "pincees"] },
  { key: "handful", dim: "count", factor: 1, label: ["poignée", "poignées"], aliases: ["handful", "handfuls", "poignee", "poignees"] },
  { key: "slice", dim: "count", factor: 1, label: ["tranche", "tranches"], aliases: ["slice", "slices", "tranche", "tranches"] },
  { key: "sprig", dim: "count", factor: 1, label: ["brin", "brins"], aliases: ["sprig", "sprigs", "brin", "brins"] },
  { key: "cube", dim: "count", factor: 1, label: ["cube", "cubes"], aliases: ["cube", "cubes"] },
  { key: "block", dim: "count", factor: 1, label: ["bloc", "blocs"], aliases: ["block", "blocks", "bloc", "blocs"] },
  { key: "piece", dim: "count", factor: 1, label: ["morceau", "morceaux"], aliases: ["piece", "pieces", "morceau", "morceaux", "bout", "bouts"] },
  { key: "inch", dim: "count", factor: 1, label: ["po", "po"], aliases: ["inch", "inches", "pouce", "pouces", "po"] },
];

export const UNIT_BY_KEY: Record<string, UnitDef> = Object.fromEntries(UNITS.map((u) => [u.key, u]));

/** All aliases sorted longest first, for greedy prefix matching. */
export const UNIT_ALIASES: { alias: string; key: string }[] = UNITS.flatMap((u) =>
  u.aliases.map((alias) => ({ alias, key: u.key })),
).sort((a, b) => b.alias.length - a.alias.length);

/** Convert an amount to its base unit (g, ml, or the count unit itself). */
export function toBase(qty: number, unit: string | null): { amount: number; dim: Dim; baseUnit: string } {
  if (!unit) return { amount: qty, dim: "count", baseUnit: "" };
  const u = UNIT_BY_KEY[unit];
  if (!u) return { amount: qty, dim: "count", baseUnit: unit };
  if (u.dim === "mass") return { amount: qty * u.factor, dim: "mass", baseUnit: "g" };
  if (u.dim === "volume") return { amount: qty * u.factor, dim: "volume", baseUnit: "ml" };
  return { amount: qty, dim: "count", baseUnit: u.key };
}

const NICE_FRACTIONS: [number, string][] = [
  [0.25, "¼"], [1 / 3, "⅓"], [0.5, "½"], [2 / 3, "⅔"], [0.75, "¾"],
];

/** 1.5 -> "1 ½", 0.333 -> "⅓", 2.37 -> "2,4" (French decimal comma). */
export function formatNumber(n: number): string {
  const whole = Math.floor(n + 1e-9);
  const frac = n - whole;
  if (frac < 0.05) return String(whole);
  for (const [v, s] of NICE_FRACTIONS) {
    if (Math.abs(frac - v) < 0.04) return whole ? `${whole} ${s}` : s;
  }
  return (Math.round(n * 10) / 10).toString().replace(".", ",");
}

export function unitLabel(unit: string | null, qty: number): string {
  if (!unit) return "";
  const u = UNIT_BY_KEY[unit];
  if (!u) return unit;
  return qty > 1 ? u.label[1] : u.label[0];
}

/** Display a base amount (g or ml) with a sensible unit: 1500 g -> "1,5 kg". */
export function formatBase(amount: number, baseUnit: string): string {
  if (baseUnit === "g") return amount >= 1000 ? `${formatNumber(amount / 1000)} kg` : `${Math.round(amount)} g`;
  if (baseUnit === "ml") return amount >= 1000 ? `${formatNumber(amount / 1000)} L` : `${Math.round(amount)} ml`;
  const label = unitLabel(baseUnit, amount);
  return label ? `${formatNumber(amount)} ${label}` : formatNumber(amount);
}
