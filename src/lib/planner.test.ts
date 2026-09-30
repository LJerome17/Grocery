import { describe, expect, it } from "vitest";
import { assignMultipliers, planWeek, seasonOf, suggest, swapFor, weekStart, type PlannerRecipe, type Rules } from "./planner";
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
});

describe("portions: whole multipliers only", () => {
  it("reaches the target with the least extra", () => {
    expect(assignMultipliers([4, 4, 4, 4, 4], 19)).toEqual([1, 1, 1, 1, 1]); // 20 = 1 extra
    expect(assignMultipliers([4, 4, 4, 4], 19)).toEqual([2, 1, 1, 1]); // 20
    expect(assignMultipliers([1, 4, 4], 12)).toEqual([4, 1, 1]); // the 1-portion bowl ×4
    expect(assignMultipliers([6, 4], 10)).toEqual([1, 1]);
  });
  it("never goes under the target", () => {
    for (const target of [1, 7, 13, 19, 25, 40]) {
      const s = [2, 4, 6, 3, 4];
      const m = assignMultipliers(s, target);
      expect(m.every((k) => Number.isInteger(k) && k >= 1)).toBe(true);
      expect(m.reduce((a, k, i) => a + k * s[i], 0)).toBeGreaterThanOrEqual(target);
    }
  });
  it("plans a week that meets the target", () => {
    const pool = [
      r("a", "bol", "tofu", { servings: 4 }),
      r("b", "salade", "végé", { servings: 6 }),
      r("c", "soupe", "légumineuses", { servings: 4 }),
      r("d", "pâtes", "fromage", { servings: 2 }),
      r("e", "mijoté", "tempeh", { servings: 4 }),
    ];
    const plan = planWeek(pool, 3, 12, rules, "automne", { random: noRandom });
    const sv = (id: string) => pool.find((p) => p.id === id)!.servings!;
    expect(plan).toHaveLength(3);
    expect(plan.reduce((a, p) => a + p.multiplier * sv(p.id), 0)).toBeGreaterThanOrEqual(12);
  });
});

describe("fewer recipes when the portions are reached exactly", () => {
  it("12 portions, up to 3 recipes: moussaka (8) + one of 4 is enough", () => {
    const pool = [
      r("moussaka", "four", "légumineuses", { servings: 8 }),
      r("bol", "bol", "tofu", { servings: 4 }),
      r("soupe", "soupe", "végé", { servings: 6 }),
    ];
    const plan = planWeek(pool, 3, 12, rules, "automne", { random: noRandom });
    const sv = (id: string) => pool.find((p) => p.id === id)!.servings!;
    expect(plan.reduce((a, p) => a + p.multiplier * sv(p.id), 0)).toBe(12);
    expect(plan.length).toBeLessThan(3);
  });
  it("keeps the number asked when it lands exactly", () => {
    const pool = ["a", "b", "c", "d", "e"].map((id, i) => r(id, `type${i}`, `p${i}`, { servings: 4 }));
    expect(planWeek(pool, 5, 20, rules, "automne", { random: noRandom })).toHaveLength(5);
  });
});

describe("category filters", () => {
  const pool = [
    r("ete", "salade", "végé", { seasons: ["ete"] }),
    r("hiver", "soupe", "végé", { seasons: ["hiver"] }),
    r("toute", "bol", "tofu"),
    r("ramen", "ramen", "tofu"),
  ];
  it("never proposes a season that was unticked, even to fill the week", () => {
    const ids = suggest(pool, 4, rules, "hiver", { random: noRandom, filters: { seasons: ["hiver"] } });
    expect(ids).not.toContain("ete");
    expect(ids).toHaveLength(3);
  });
  it("leaves out excluded dish types", () => {
    expect(suggest(pool, 4, rules, "hiver", { random: noRandom, filters: { excludeDishTypes: ["ramen"] } })).not.toContain("ramen");
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
