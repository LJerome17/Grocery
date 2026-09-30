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

export const AISLE_LABEL: Record<string, string> = Object.fromEntries(AISLES);
export const AISLE_ORDER: Record<string, number> = Object.fromEntries(AISLES.map(([k], i) => [k, i]));
/** Catalogue aisle for things never bought (water). */
export const NO_AISLE = "aucun";
