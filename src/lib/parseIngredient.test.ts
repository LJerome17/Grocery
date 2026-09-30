import { describe, expect, it } from "vitest";
import { parseIngredientBlock, parseIngredientLine } from "./parseIngredient";

const p = (s: string) => {
  const r = parseIngredientLine(s);
  return { q: r.quantity, max: r.quantityMax, u: r.unit, n: r.name, note: r.note, opt: r.optional };
};

describe("parseIngredientLine (English)", () => {
  it.each([
    ["2 tbs Olive Oil, for frying", { q: 2, u: "tbsp", n: "Olive Oil", note: "for frying" }],
    ["1 Red Onion, finely sliced", { q: 1, u: null, n: "Red Onion", note: "finely sliced" }],
    ["3 cloves Garlic, minced", { q: 3, u: "clove", n: "Garlic" }],
    ["4 sticks Celery, finely sliced", { q: 4, u: "stalk", n: "Celery" }],
    ["1 medium Aubergine, cubed", { q: 1, u: null, n: "Aubergine", note: "cubed; medium" }],
    ["400g/1 packet Vegan Mince (alternatively, used mushrooms or lentils)", { q: 400, u: "g", n: "Vegan Mince" }],
    ["2 tins Chopped Tomatoes", { q: 2, u: "can", n: "Chopped Tomatoes" }],
    ["1 heaped tbs Mixed Herb", { q: 1, u: "tbsp", n: "Mixed Herb" }],
    ["1/2 cup Butter", { q: 0.5, u: "cup", n: "Butter" }],
    ["Pinch Nutmeg", { q: 1, u: "pinch", n: "Nutmeg" }],
    ["1 cup Grated Vegan Cheese (optional)", { q: 1, u: "cup", n: "Grated Vegan Cheese", opt: true }],
    ["1 ½ cups all-purpose flour", { q: 1.5, u: "cup", n: "all-purpose flour" }],
    ["2-3 limes", { q: 2, max: 3, u: null, n: "limes" }],
    ["2 x 400g tins chickpeas", { q: 2, u: "can", n: "chickpeas" }],
    ["Salt and pepper to taste", { q: null, u: null, n: "Salt and pepper", note: "to taste" }],
    ["a pinch of salt", { q: 1, u: "pinch", n: "salt" }],
    ["14 oz can Chickpeas, drained", { q: 1, u: "can", n: "Chickpeas", note: "drained; 14 oz" }],
    ["1 (14 oz) can coconut milk", { q: 1, u: "can", n: "coconut milk", note: "14 oz" }],
    ["1 lime", { q: 1, u: null, n: "lime" }],
    ["2 tbsp + 1 tsp avocado oil", { u: "tbsp", n: "avocado oil" }],
    ["3 × 100 g packs ramen noodles", { q: 3, u: "pack", n: "ramen noodles", note: "100 g" }],
    ["2 16 ounce blocks extra firm tofu, (drained and pressed)", { q: 2, u: "block", n: "extra firm tofu" }],
    ["1 cup vegetable stock ((240g))", { q: 1, u: "cup", n: "vegetable stock", note: "240g" }],
    ["Half Avocado, cubed", { q: 0.5, n: "Avocado" }],
    ["4 C. Mixed Leaf Lettuce", { q: 4, u: "cup", n: "Mixed Leaf Lettuce" }],
    ["1 thumb-sized piece of ginger", { q: 1, u: "inch", n: "ginger" }],
    ["3inch piece ginger, finely chopped", { q: 3, u: "inch", n: "ginger" }],
    ["1 bout de gingembre d’un pouce, râpé finement", { q: 1, u: "inch", n: "gingembre" }],
    ["Juice of 1 lemon", { q: 1, n: "lemon", note: "juice" }],
  ])("%s", (line, expected) => {
    expect(p(line)).toMatchObject(expected);
  });
});

describe("parseIngredientLine (français)", () => {
  it.each([
    ["2 tasses de farine", { q: 2, u: "cup", n: "farine" }],
    ["1 c. à soupe d'huile d'olive", { q: 1, u: "tbsp", n: "huile d'olive" }],
    ["15 ml (1 c. à soupe) de sirop d'érable", { q: 15, u: "ml", n: "sirop d'érable", note: "1 c. à soupe" }],
    ["1 boîte de 796 ml de tomates en dés", { q: 1, u: "can", n: "tomates en dés", note: "796 ml" }],
    ["2 gousses d’ail, hachées", { q: 2, u: "clove", n: "ail", note: "hachées" }],
    ["1 oignon jaune, haché finement", { q: 1, u: null, n: "oignon jaune" }],
    ["2 à 3 c. à thé de cumin", { q: 2, max: 3, u: "tsp", n: "cumin" }],
    ["500 g de bœuf haché", { q: 500, u: "g", n: "bœuf haché" }],
    ["1,5 L de bouillon de légumes", { q: 1.5, u: "l", n: "bouillon de légumes" }],
    ["Coriandre fraîche (facultatif)", { q: null, n: "Coriandre fraîche", opt: true }],
    ["1 botte de coriandre", { q: 1, u: "bunch", n: "coriandre" }],
    ["Sel et poivre au goût", { q: null, n: "Sel et poivre" }],
    ["1 c à table d’huile végétale", { q: 1, u: "tbsp", n: "huile végétale" }],
    ["¼ de tasse de noix de Grenoble", { q: 0.25, u: "cup", n: "noix de Grenoble" }],
    ["1 bloc (454g) de tofu extra-ferme", { q: 1, u: "block", n: "tofu extra-ferme", note: "454g" }],
    ["1 bloc de 350 à 450 g tofu extra ferme", { q: 1, u: "block", n: "tofu extra ferme", note: "350 à 450 g" }],
    ["1 bloc de tofu de 315 g, en tranches", { q: 1, u: "block", n: "tofu" }],
    ["Un demi-oignon rouge, tranché finement", { q: 0.5, u: null, n: "oignon rouge" }],
    ["Jus d'une lime", { q: 1, u: null, n: "lime", note: "jus" }],
    ["Zeste de 1 lime bien lavée", { q: 1, n: "lime bien lavée", note: "zeste" }],
    ["+/- 4 ½ tasses de bouillon de légumes", { q: 4.5, u: "cup", n: "bouillon de légumes" }],
    ["Pesto végétalien maison ou du commerce - 125 ml", { q: 125, u: "ml", n: "Pesto végétalien maison ou du commerce" }],
    ["Nouilles orientales ou soba — 250 g", { q: 250, u: "g", n: "Nouilles orientales ou soba" }],
    ["Fromage Halloumi : un bloc", { q: 1, u: "block", n: "Fromage Halloumi" }],
    ["Fromage Halloumi : un bloc de 235g, tranché ¼ pouce", { q: 1, u: "block", n: "Fromage Halloumi", note: "tranché 1/4 pouce; 235g" }],
    ["Pour servir : naan", { q: null, n: "naan", note: "pour servir" }],
    ["-200g de champignons au choix", { q: 200, u: "g", n: "champignons au choix" }],
  ])("%s", (line, expected) => {
    expect(p(line)).toMatchObject(expected);
  });
});

describe("parseIngredientBlock", () => {
  it("tracks sections from headers", () => {
    const out = parseIngredientBlock(["Pour la sauce :", "1 tasse de lait", { text: "Pâtes", bold: true }, "1 paquet de lasagnes"]);
    expect(out.map((i) => [i.section, i.name])).toEqual([
      ["sauce", "lait"],
      ["Pâtes", "lasagnes"],
    ]);
  });
});
