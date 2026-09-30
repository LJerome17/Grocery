// Validation of unit conversions and buying-unit equivalences, through the real functions and the real catalogue.
// Assertions state what is CORRECT for a Québec grocery store. When the app is wrong, the test is `it.fails`
// with a comment explaining why (it passes as long as the bug is there, and turns red once it is fixed).

import { afterEach, describe, expect, it } from "vitest";
import catalogJson from "../../data/catalog.json";
import { buildShoppingList, type CatalogItem, type ListIngredient } from "../lib/shopping";
import { formatBase, formatNumber, toBase } from "../lib/units";
import { setLang } from "../lib/i18n";

// Real catalogue, keyed by its French name.
const catalog = new Map<string, CatalogItem>(
  (catalogJson.ingredients as unknown as Omit<CatalogItem, "id">[]).map((c) => [c.name, { ...c, id: c.name } as CatalogItem]),
);

const ing = (id: string | null, quantity: number | null, unit: string | null, quantity_max: number | null = null, name = id ?? "?"): ListIngredient => ({
  quantity, quantity_max, unit, name, optional: false, ingredient_id: id,
});

/** quantityText of one catalogue item after adding up all the given recipes. */
function qty(id: string, recipes: ListIngredient[][], factor = 1): string {
  for (const r of recipes) for (const i of r) if (i.ingredient_id && !catalog.has(i.ingredient_id)) throw new Error(`not in catalogue: ${i.ingredient_id}`);
  const list = buildShoppingList(recipes.map((ingredients, n) => ({ title: `R${n}`, factor, ingredients })), catalog);
  const line = list.find((l) => l.ingredientId === id);
  if (!line) throw new Error(`no line for ${id}`);
  return line.quantityText;
}

afterEach(() => setLang("fr"));

describe("unit factors (to g / ml)", () => {
  it("volume units", () => {
    expect(toBase(1, "tsp").amount).toBe(5);
    expect(toBase(1, "tbsp").amount).toBe(15);
    expect(toBase(1, "cup").amount).toBe(250); // Canadian metric cup
    expect(toBase(1, "cl").amount).toBe(10);
    expect(toBase(1, "l").amount).toBe(1000);
    expect(toBase(1, "floz").amount).toBeCloseTo(29.5735, 1);
  });
  it("mass units", () => {
    expect(toBase(1, "kg").amount).toBe(1000);
    expect(toBase(1, "lb").amount).toBeCloseTo(453.592, 0);
    expect(toBase(1, "oz").amount).toBeCloseTo(28.3495, 1);
    expect(toBase(1000, "mg").amount).toBeCloseTo(1, 9);
    expect(toBase(2, "lb")).toMatchObject({ dim: "mass", baseUnit: "g" });
  });
  it("250 ml vs US 236.6 ml cup differs by < 6 %: negligible at grocery scale", () => {
    const us = 4 * 236.59, ca = toBase(4, "cup").amount;
    expect((ca - us) / us).toBeLessThan(0.06);
  });
  it("count units stay in their own unit", () => {
    expect(toBase(3, "clove")).toEqual({ amount: 3, dim: "count", baseUnit: "clove" });
    expect(toBase(2, null)).toEqual({ amount: 2, dim: "count", baseUnit: "" });
  });
});

describe("formatNumber / formatBase", () => {
  it("fractions and decimals", () => {
    expect(formatNumber(1.5)).toBe("1 ½");
    expect(formatNumber(1 / 3)).toBe("⅓");
    expect(formatNumber(0.75)).toBe("¾");
    expect(formatNumber(2)).toBe("2");
    expect(formatNumber(1.96)).toBe("2");
    expect(formatNumber(2.2)).toBe("2,2");
    // 2.37 snaps to "2 ⅓" (1.5 % off; the units.ts comment promises "2,4", harmless).
    expect(formatNumber(2.37)).toBe("2 ⅓");
    setLang("en");
    expect(formatNumber(2.2)).toBe("2.2");
  });
  it("switches to kg / L above 1000", () => {
    // kg and L are written in decimals, never fractions (changed 2026-09-30).
    expect(formatBase(1500, "g")).toBe("1,5 kg");
    expect(formatBase(1250, "ml")).toBe("1,3 L");
    expect(formatBase(1200, "ml")).toBe("1,2 L");
    expect(formatBase(450, "g")).toBe("450 g");
    expect(formatBase(62.5, "ml")).toBe("63 ml");
    // 1040 g -> "1 kg": rounds down by at most 5 %, acceptable on a grocery list.
    expect(formatBase(1040, "g")).toBe("1 kg");
  });
  it("count units with French / English labels", () => {
    expect(formatBase(3, "clove")).toBe("3 gousses");
    expect(formatBase(1, "can")).toBe("1 boîte");
    setLang("en");
    expect(formatBase(3, "clove")).toBe("3 cloves");
    expect(formatBase(1, "can")).toBe("1 can");
    expect(formatBase(1200, "ml")).toBe("1.2 L");
  });
  // Fixed 2026-09-30: formatBase rounds before choosing kg/L, so 999.6 ml shows as "1 L" (was "1000 ml").
  it("999.6 ml shows as 1 L, not 1000 ml", () => {
    expect(formatBase(999.6, "ml")).toBe("1 L");
  });
  // Fixed 2026-09-30: a non-zero trace (e.g. 200 mg of saffron) shows at least "1 g" / "1 ml", never "0".
  it("never displays 0 g for a non-zero amount", () => {
    expect(formatBase(toBase(200, "mg").amount, "g")).toBe("1 g");
    expect(formatBase(0.3, "ml")).toBe("1 ml");
    expect(formatBase(0, "g")).toBe("0 g");
  });
});

describe("shopping list: volumes and weights", () => {
  it("1 cup + 250 ml broth = 500 ml", () => {
    expect(qty("Bouillon de légumes", [[ing("Bouillon de légumes", 1, "cup")], [ing("Bouillon de légumes", 250, "ml")]])).toBe("500 ml");
  });
  it("4 cups + 1 L broth = 2 L", () => {
    expect(qty("Bouillon de légumes", [[ing("Bouillon de légumes", 4, "cup")], [ing("Bouillon de légumes", 1, "l")]])).toBe("2 L");
  });
  // User decision (2026-09-30): they use Better than Bouillon, so broth is listed as the recipes ask, without cube conversion.
  it("broth is listed as asked (no cube conversion)", () => {
    expect(qty("Bouillon de légumes", [[ing("Bouillon de légumes", 1, null)], [ing("Bouillon de légumes", 1, "cup")]])).toBe("1 + 250 ml");
    expect(qty("Bouillon de légumes", [[ing("Bouillon de légumes", 1, "cup")], [ing("Bouillon de légumes", 500, "ml")]])).toBe("750 ml");
  });
  it("broth ranges keep the unit once", () => {
    expect(qty("Bouillon de légumes", [[ing("Bouillon de légumes", 4, "cup", 5)]])).toBe("1 à 1,3 L"); // litres in decimals (changed 2026-09-30)
    expect(qty("Bouillon de légumes", [[ing("Bouillon de légumes", 0.25, "cup", 0.5)]])).toBe("63 à 125 ml");
  });
  it("dry lentils: 1 cup = 200 g (not inverted)", () => {
    expect(qty("Lentilles brunes ou vertes (sèches)", [[ing("Lentilles brunes ou vertes (sèches)", 1, "cup")]])).toBe("200 g");
    expect(qty("Lentilles corail", [[ing("Lentilles corail", 1.5, "cup")], [ing("Lentilles corail", 120, "g")]])).toBe("420 g");
  });
  // User decision (2026-09-30): spinach is bought in 200 g bags; 1 cup = 30 g, 1 bunch = 250 g.
  it("spinach: bought in 200 g bags (2 cups = 60 g -> 1 bag; 1 bunch + 100 g = 350 g -> 2 bags; 400 g -> 2 bags)", () => {
    expect(qty("Épinards", [[ing("Épinards", 2, "cup")]])).toBe("1 paquet");
    expect(qty("Épinards", [[ing("Épinards", 1, "bunch")], [ing("Épinards", 100, "g")]])).toBe("2 paquets");
    expect(qty("Épinards", [[ing("Épinards", 400, "g")]])).toBe("2 paquets");
  });
  it("scaling ×2 doubles before converting", () => {
    expect(qty("Lentilles corail", [[ing("Lentilles corail", 1, "cup")]], 2)).toBe("400 g");
  });
  // Fixed 2026-09-30: cooked grains go through catalogue cooked_ratio (Riz blanc 3). 2 cups cooked ≈ ⅔ cup dry,
  // so 2 cups cooked + 1 ¾ cups dry needs about 600 ml of dry rice, not 938 ml.
  it("cooked rice is not counted as dry rice", () => {
    const text = qty("Riz blanc", [[ing("Riz blanc", 2, "cup", null, "cooked white rice")], [ing("Riz blanc", 1.75, "cup", null, "riz blanc sec")]]);
    expect(parseFloat(text)).toBeLessThan(700);
    expect(text).toBe("604 ml"); // 500 / 3 + 437.5
  });
  // Fixed 2026-09-30: "3 tasses (630 g) de riz à sushi cuit" now puts 250 ml of dry sushi rice on the list (was 750 ml).
  it("cooked sushi rice is converted to dry", () => {
    const text = qty("Riz à sushi", [[ing("Riz à sushi", 3, "cup", null, "riz à sushi cuit")]]);
    expect(parseFloat(text)).toBeLessThan(400);
    expect(text).toBe("250 ml");
  });
});

describe("shopping list: garlic, ginger, herbs, produce", () => {
  it("3 cloves + 1 tbsp minced garlic = 6 cloves", () => {
    expect(qty("Ail", [[ing("Ail", 3, "clove")], [ing("Ail", 1, "tbsp")]])).toBe("6 gousses");
  });
  it("1 head + 2 cloves = 12 cloves; bare numbers and 'pieces' are cloves", () => {
    expect(qty("Ail", [[ing("Ail", 1, "head")], [ing("Ail", 2, "clove")]])).toBe("12 gousses");
    expect(qty("Ail", [[ing("Ail", 2, null)]])).toBe("2 gousses");
    expect(qty("Ail", [[ing("Ail", 5, "piece")]])).toBe("5 gousses");
    expect(qty("Ail", [[ing("Ail", 1, "tsp")]])).toBe("1 gousse");
  });
  it("garlic ranges add up low and high ends", () => {
    expect(qty("Ail", [[ing("Ail", 1, "clove", 2)], [ing("Ail", 3, "clove")]])).toBe("4 à 5 gousses");
  });
  it("garlic ×2", () => {
    expect(qty("Ail", [[ing("Ail", 3, "clove")]], 2)).toBe("6 gousses");
  });
  it("ginger: 1 tbsp ≈ 1 inch; 15 g ≈ 1 inch; 1 ½ inch rounds up to 2", () => {
    expect(qty("Gingembre", [[ing("Gingembre", 2, "tbsp")], [ing("Gingembre", 1, "inch")]])).toBe("3 pouces");
    expect(qty("Gingembre", [[ing("Gingembre", 15, "g")]])).toBe("1 pouce");
    expect(qty("Gingembre", [[ing("Gingembre", 1.5, "inch")]])).toBe("2 pouces");
  });
  it("onions: 1 + 1 cup chopped = 2; ½ + ¼ rounds up to 1", () => {
    expect(qty("Oignon jaune", [[ing("Oignon jaune", 1, null)], [ing("Oignon jaune", 1, "cup")]])).toBe("2");
    expect(qty("Oignon rouge", [[ing("Oignon rouge", 0.5, null)], [ing("Oignon rouge", 0.25, null)]])).toBe("1");
  });
  it("green onions: 2 + 1 bunch (6) = 8; 1 tbsp = 1", () => {
    expect(qty("Oignon vert", [[ing("Oignon vert", 2, null)], [ing("Oignon vert", 1, "bunch")]])).toBe("8");
    expect(qty("Oignon vert", [[ing("Oignon vert", 15, "ml")]])).toBe("1");
  });
  it("cilantro: ½ cup + 1 tbsp = 1 bunch", () => {
    expect(qty("Coriandre fraîche", [[ing("Coriandre fraîche", 0.5, "cup")], [ing("Coriandre fraîche", 1, "tbsp")]])).toBe("1 botte");
  });
  it("lemon / lime juice to fruits", () => {
    expect(qty("Citron", [[ing("Citron", 0.25, "cup")]])).toBe("2"); // 60 ml / 45 ml
    expect(qty("Citron", [[ing("Citron", 1, "tbsp")]])).toBe("1");
    expect(qty("Lime", [[ing("Lime", 3, "tbsp")]])).toBe("2"); // 45 ml / 30 ml
  });
  it("carrots and potatoes", () => {
    expect(qty("Carotte", [[ing("Carotte", 3, "cup")]])).toBe("6");
    expect(qty("Pomme de terre", [[ing("Pomme de terre", 2.25, "lb")]])).toBe("6"); // 1021 g / 200 g = 5.1: whole units round up past a 0.1 tolerance
  });
  it("cherry tomatoes: 280 g + 1 cup = 2 containers", () => {
    expect(qty("Tomates cerises", [[ing("Tomates cerises", 280, "g")], [ing("Tomates cerises", 1, "cup")]])).toBe("2 barquettes");
  });
  // Fixed 2026-09-30: Tomates cerises no longer has count_unit "punnet", so a bare count stays a count of tomatoes
  // (was 10 containers). The app does not convert tomatoes to containers; "10" is what the recipe asked.
  it("10 cherry tomatoes stays 10, not 10 containers", () => {
    expect(qty("Tomates cerises", [[ing("Tomates cerises", 10, null)]])).toBe("10");
  });
  it("celery stalks add up", () => {
    expect(qty("Céleri", [[ing("Céleri", 2, "stalk")], [ing("Céleri", 3, null)]])).toBe("5 branches");
  });
});

describe("shopping list: cans, blocks, whole units", () => {
  it("1 can + 200 g chickpeas = 2 cans", () => {
    expect(qty("Pois chiches (conserve)", [[ing("Pois chiches (conserve)", 1, "can")], [ing("Pois chiches (conserve)", 200, "g")]])).toBe("2 boîtes (540 ml)"); // can size shown (2026-09-30)
  });
  it("1 ½ cups cooked chickpeas = 1 can; ½ can = 1 can (never 0)", () => {
    expect(qty("Pois chiches (conserve)", [[ing("Pois chiches (conserve)", 1.5, "cup")]])).toBe("1 boîte (540 ml)");
    expect(qty("Pois chiches (conserve)", [[ing("Pois chiches (conserve)", 0.5, "can")]])).toBe("1 boîte (540 ml)");
  });
  it("chickpeas ×3", () => {
    expect(qty("Pois chiches (conserve)", [[ing("Pois chiches (conserve)", 1, "can")]], 3)).toBe("3 boîtes (540 ml)");
  });
  // Fixed 2026-09-30: a Canadian 540 ml can gives about 2 cups (500 ml) drained (equiv ml 500, was 375 = US 15 oz can).
  // A starter recipe says it itself: "2 tasses (400 g) de lentilles cuites ou 1 conserve de 540 ml".
  it("2 cups cooked chickpeas = 1 can of 540 ml", () => {
    expect(qty("Pois chiches (conserve)", [[ing("Pois chiches (conserve)", 2, "cup")]])).toBe("1 boîte (540 ml)");
  });
  it("2 cups cooked lentils = 1 can of 540 ml", () => {
    expect(qty("Lentilles brunes (conserve)", [[ing("Lentilles brunes (conserve)", 2, "cup")]])).toBe("1 boîte (540 ml)");
  });
  it("400 g + 1 lb firm tofu = 2 blocks", () => {
    expect(qty("Tofu ferme", [[ing("Tofu ferme", 400, "g")], [ing("Tofu ferme", 1, "lb")]])).toBe("2 blocs");
  });
  it("tofu: 350 g, ¼ block, pack = block", () => {
    expect(qty("Tofu extra-ferme", [[ing("Tofu extra-ferme", 350, "g")]])).toBe("1 bloc");
    expect(qty("Tofu ferme", [[ing("Tofu ferme", 0.25, "block")]])).toBe("1 bloc");
    expect(qty("Tofu extra-ferme", [[ing("Tofu extra-ferme", 2, "block")], [ing("Tofu extra-ferme", 1, "pack")]])).toBe("3 blocs");
  });
  it("firm and extra-firm tofu stay two lines", () => {
    const list = buildShoppingList([{ title: "A", factor: 1, ingredients: [ing("Tofu ferme", 1, "block"), ing("Tofu extra-ferme", 1, "block")] }], catalog);
    expect(list.filter((l) => l.label.startsWith("Tofu")).map((l) => l.quantityText)).toEqual(["1 bloc", "1 bloc"]);
  });
  it("coconut milk: 1 cup + 45 ml = 1 can; 1 can + 1 cup = 2 cans", () => {
    expect(qty("Lait de coco", [[ing("Lait de coco", 1, "cup")], [ing("Lait de coco", 45, "ml")]])).toBe("1 boîte (400 ml)");
    expect(qty("Lait de coco", [[ing("Lait de coco", 1, "can")], [ing("Lait de coco", 1, "cup")]])).toBe("2 boîtes (400 ml)");
  });
  it("diced tomatoes: 2 cups = 1 can of 796 ml; a bare 1 is a can", () => {
    expect(qty("Tomates en dés (conserve)", [[ing("Tomates en dés (conserve)", 2, "cup")]])).toBe("1 boîte (796 ml)");
    expect(qty("Tomates en dés (conserve)", [[ing("Tomates en dés (conserve)", 1, null)]])).toBe("1 boîte (796 ml)");
  });
  it("tempeh 240 g = 1 pack; mozzarella ball", () => {
    expect(qty("Tempeh", [[ing("Tempeh", 240, "g")]])).toBe("1 paquet");
    expect(qty("Mozzarella fraîche", [[ing("Mozzarella fraîche", 1, null)]])).toBe("1 boule");
  });
});

describe("negligible and missing quantities", () => {
  it("a pinch, a sprig, a drizzle or no quantity -> au besoin", () => {
    expect(qty("Coriandre fraîche", [[ing("Coriandre fraîche", 1, "sprig")]])).toBe("au besoin");
    expect(qty("Lait de coco", [[ing("Lait de coco", 1, "drizzle")]])).toBe("au besoin");
    expect(qty("Coriandre fraîche", [[ing("Coriandre fraîche", null, null)]])).toBe("au besoin");
    const list = buildShoppingList([{ title: "A", factor: 1, ingredients: [ing(null, 1, "pinch", null, "Sel")] }], catalog);
    expect(list[0].quantityText).toBe("au besoin");
  });
  it("a negligible amount next to a real one does not add 'au besoin'", () => {
    expect(qty("Ail", [[ing("Ail", 2, "clove")], [ing("Ail", 1, "pinch")]])).toBe("2 gousses");
  });
});

describe("English mode", () => {
  it("labels, ranges and 'as needed' in English", () => {
    setLang("en");
    expect(qty("Ail", [[ing("Ail", 3, "clove")], [ing("Ail", 1, "tbsp")]])).toBe("6 cloves");
    expect(qty("Ail", [[ing("Ail", 1, "clove", 2)], [ing("Ail", 3, "clove")]])).toBe("4 to 5 cloves");
    expect(qty("Pois chiches (conserve)", [[ing("Pois chiches (conserve)", 1, "can")], [ing("Pois chiches (conserve)", 200, "g")]])).toBe("2 cans (540 ml)");
    expect(qty("Bouillon de légumes", [[ing("Bouillon de légumes", 4, "cup", 5)]])).toBe("1 to 1.3 L"); // litres in decimals (changed 2026-09-30)
    expect(qty("Coriandre fraîche", [[ing("Coriandre fraîche", null, null)]])).toBe("as needed");
    const list = buildShoppingList([{ title: "A", factor: 1, ingredients: [ing("Ail", 1, "clove")] }], catalog);
    expect(list[0].label).toBe("Garlic");
  });
  it("French decimal range", () => {
    expect(qty("Bouillon de légumes", [[ing("Bouillon de légumes", 1100, "ml", 1600)]])).toBe("1,1 à 1,6 L");
  });
  // Fixed 2026-09-30: English decimal ranges write the unit once, like French "1,1 à 1,6 L" (was "1.1 L to 1.6 L").
  it("English decimal range writes the unit once", () => {
    setLang("en");
    expect(qty("Bouillon de légumes", [[ing("Bouillon de légumes", 1100, "ml", 1600)]])).toBe("1.1 to 1.6 L");
  });
});
