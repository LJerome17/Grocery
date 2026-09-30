import { lang } from "./i18n";

// Store aisles, in the order the shopping list is displayed (roughly a Maxi walk-through).
export const AISLES: [key: string, label: string][] = [
  ["fruits-legumes", "Fruits et légumes"],
  ["boulangerie", "Boulangerie"],
  ["viandes", "Viandes et poissons"],
  ["refrigeres", "Tofu et réfrigérés"],
  ["laitiers", "Produits laitiers et œufs"],
  ["cereales", "Pâtes, riz et céréales"],
  ["conserves", "Conserves et bouillons"],
  ["international", "Cuisine du monde"],
  ["condiments", "Huiles, vinaigres et sauces"],
  ["cuisson", "Farine, sucre et cuisson"],
  ["epices", "Épices et herbes séchées"],
  ["noix", "Noix et graines"],
  ["collations", "Croustilles et collations"],
  ["surgeles", "Surgelés"],
  ["boissons", "Vins et boissons"],
  ["autre", "Autre"],
];

const AISLE_FR: Record<string, string> = Object.fromEntries(AISLES);
const AISLE_EN: Record<string, string> = {
  "fruits-legumes": "Produce", boulangerie: "Bakery", viandes: "Meat and fish", refrigeres: "Tofu and refrigerated",
  laitiers: "Dairy and eggs", cereales: "Pasta, rice and grains", conserves: "Canned goods and broths",
  international: "International foods", condiments: "Oils, vinegars and sauces", cuisson: "Baking",
  epices: "Spices and dried herbs", noix: "Nuts and seeds", collations: "Chips and snacks", surgeles: "Frozen",
  boissons: "Wine and drinks", autre: "Other",
};

/** Aisle name in the household's language. */
export function aisleLabel(key: string): string {
  return (lang() === "en" ? AISLE_EN[key] : AISLE_FR[key]) ?? AISLE_FR.autre;
}
export const AISLE_ORDER: Record<string, number> = Object.fromEntries(AISLES.map(([k], i) => [k, i]));
/** Catalogue aisle for things never bought (water). */
export const NO_AISLE = "aucun";
