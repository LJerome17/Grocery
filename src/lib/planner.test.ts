import { describe, expect, it } from "vitest";
import { portionsPerRecipe, seasonOf, suggest, swapFor, weekStart, type PlannerRecipe, type Rules } from "./planner";
import { buildShoppingList, type CatalogItem } from "./shopping";

const rules: Rules = { maxSameDishType: 1, maxSameProtein: 2, cooldownWeeks: 3 };
const noRandom = () => 0;
const r = (id: string, dishType: string, protein: string, extra: Partial<PlannerRecipe> = {}): PlannerRecipe => ({
  id,
  dishType,
  protein,
  seasons: ["printemps", "ete", "automne", "hiver"],
  rating: null,
  ingredientIds: [],
  weeksSinceEaten: null,
  ...extra,
});

describe("calendar helpers", () => {
  it("finds the season", () => {
    expect(seasonOf(new Date(2026, 8, 29))).toBe("automne");
    expect(seasonOf(new Date(2026, 0, 10))).toBe("hiver");
    expect(seasonOf(new Date(2026, 6, 1))).toBe("ete");
  });
  it("finds the Monday", () => {
    expect(weekStart(new Date(2026, 8, 29))).toBe("2026-09-28"); // Tuesday
    expect(weekStart(new Date(2026, 9, 4))).toBe("2026-09-28"); // Sunday
  });
  it("spreads lunches over the suppers", () => {
    expect(portionsPerRecipe(4, 2, 5)).toEqual([4, 3, 3, 3]);
    expect(portionsPerRecipe(3, 2, 0)).toEqual([2, 2, 2]);
  });
});

describe("suggest", () => {
  const recipes = [
    r("ramen1", "ramen", "tofu"),
    r("ramen2", "ramen", "tofu"),
    r("ramen3", "ramen", "tempeh"),
    r("salade", "salade", "légumineuses"),
    r("cari", "mijoté", "légumineuses"),
    r("pates", "pâtes", "fromage"),
    r("bol", "bol", "tofu"),
    r("bol2", "bol", "tofu"),
    r("pesto", "accompagnement", "végé"),
  ];

  it("never puts two ramen or three tofu dishes in the same week", () => {
    for (let seed = 0; seed < 20; seed++) {
      let x = seed;
      const random = () => ((x = (x * 9301 + 49297) % 233280) / 233280);
      const week = suggest(recipes, 5, rules, "automne", { random }).map((id) => recipes.find((y) => y.id === id)!);
      expect(week).toHaveLength(5);
      expect(week.filter((w) => w.dishType === "ramen")).toHaveLength(1);
      expect(week.filter((w) => w.protein === "tofu").length).toBeLessThanOrEqual(2);
      expect(week.some((w) => w.id === "pesto")).toBe(false);
    }
  });

  it("prefers in-season recipes and skips recent ones", () => {
    const pool = [
      r("ete", "salade", "végé", { seasons: ["ete"] }),
      r("automne", "soupe", "végé", { seasons: ["automne"] }),
      r("recent", "bol", "tofu", { weeksSinceEaten: 1 }),
      r("ancien", "pâtes", "fromage", { weeksSinceEaten: 8 }),
    ];
    expect(suggest(pool, 2, rules, "automne", { random: noRandom }).sort()).toEqual(["ancien", "automne"]);
  });

  it("relaxes the rules rather than planning fewer meals", () => {
    const pool = [r("a", "ramen", "tofu"), r("b", "ramen", "tofu"), r("c", "ramen", "tofu")];
    expect(suggest(pool, 3, rules, "automne", { random: noRandom })).toHaveLength(3);
  });

  it("swaps one recipe for another that still fits the rules", () => {
    const week = ["ramen1", "salade", "pates"];
    const next = swapFor(recipes, week, "ramen1", rules, "automne", { random: noRandom });
    expect(next).not.toBeNull();
    expect(week).not.toContain(next);
    expect(next).not.toBe("pesto");
  });
});

describe("buildShoppingList", () => {
  const catalog = new Map<string, CatalogItem>([
    ["oignon", { id: "oignon", name: "Oignon jaune", aisle: "fruits-legumes", pantry: false }],
    ["lait-coco", { id: "lait-coco", name: "Lait de coco", aisle: "conserves", pantry: false }],
    ["sel", { id: "sel", name: "Sel", aisle: "epices", pantry: true }],
    ["eau", { id: "eau", name: "Eau", aisle: "aucun", pantry: false }],
  ]);
  const ing = (ingredient_id: string | null, quantity: number | null, unit: string | null, name = "x", optional = false) => ({
    ingredient_id,
    quantity,
    unit,
    name,
    optional,
  });

  it("adds up, rounds whole items up and sorts pantry last", () => {
    const list = buildShoppingList(
      [
        { title: "Cari", factor: 1.5, ingredients: [ing("oignon", 1, null), ing("lait-coco", 1, "can"), ing("sel", 1, "tsp"), ing("eau", 1, "cup")] },
        { title: "Soupe", factor: 1, ingredients: [ing("oignon", 2, null), ing("lait-coco", 250, "ml"), ing(null, 2, "tbsp", "Sauce mystère")] },
      ],
      catalog,
    );
    expect(list.map((l) => [l.label, l.quantityText])).toEqual([
      ["Oignon jaune", "4"],
      ["Lait de coco", "2 boîtes + 250 ml"],
      ["Sauce mystère", "30 ml"],
      ["Sel", "8 ml"],
    ]);
    expect(list.find((l) => l.label === "Oignon jaune")!.recipes).toEqual(["Cari", "Soupe"]);
    expect(list.at(-1)!.pantry).toBe(true);
  });

  it("marks items only used as optional", () => {
    const list = buildShoppingList([{ title: "A", factor: 1, ingredients: [ing(null, null, null, "Coriandre", true)] }], catalog);
    expect(list[0]).toMatchObject({ optional: true, quantityText: "au besoin" });
  });
});
