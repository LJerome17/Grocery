import { describe, expect, it } from "vitest";
import catalog from "../../data/catalog.json";
import { buildAliasIndex, matchIngredient } from "./catalog";

const index = buildAliasIndex(catalog.ingredients.map((i) => ({ id: i.name, aliases: i.aliases })));

describe("matchIngredient", () => {
  it.each([
    ["Red Onion", "Oignon rouge"],
    ["oignon rouge haché finement", "Oignon rouge"],
    ["oignon vert haché pour décorer", "Oignon vert"],
    ["sirop d’érable ou de miel", "Sirop d'érable"],
    ["poudre d’ail", "Poudre d'ail"],
    ["filet de lait de coco ou yogourt nature", "Lait de coco"],
    ["extra-firm tofu", "Tofu extra-ferme"],
    ["tofu ferme ou extra-ferme", "Tofu ferme"],
    ["pommes de terre russet ou yukon gold", "Pomme de terre"],
    ["avocado oil", "Huile d'avocat"],
    ["Avocado", "Avocat"],
    ["water", "Eau"],
  ])("%s -> %s", (name, expected) => {
    expect(matchIngredient(name, index)).toBe(expected);
  });

  it("returns null for unknown ingredients", () => {
    expect(matchIngredient("fruit du dragon", index)).toBeNull();
  });
});
