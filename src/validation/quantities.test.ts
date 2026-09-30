// Representative ingredient lines from the 69 starter recipes (public/starter/recipes.json),
// checked against parseIngredientLine. Known parser bugs are marked it.fails with the reason.
import { describe, expect, it } from "vitest";
import { parseIngredientLine } from "../lib/parseIngredient";

const p = (s: string) => {
  const r = parseIngredientLine(s);
  return { q: r.quantity, max: r.quantityMax, u: r.unit, n: r.name, opt: r.optional };
};

describe("starter lines parsed correctly", () => {
  it.each([
    // containers with a size in parentheses
    ["1 boîte de 540 ml (19 oz) Pois chiches, rincés et égouttés", { q: 1, max: null, u: "can", n: "Pois chiches" }],
    ["1 boîte de conserve (540 ml) pois chiches, rincés et égouttés", { q: 1, u: "can" }],
    ["2 conserves de 398 ml de haricots noirs, bien rincés et égouttés", { q: 2, u: "can", n: "haricots noirs" }],
    ["1 (14.5 ounce) can whole peeled tomatoes, chopped", { q: 1, u: "can" }],
    ["½ (14.5 ounce) can lentils, drained with liquid reserved", { q: 0.5, u: "can", n: "lentils" }],
    ["13.5 oz can coconut milk ((1 2/3 cups or 400g))", { q: 1, u: "can", n: "coconut milk" }],
    ["2 16 ounce blocks extra firm tofu, (drained and pressed)", { q: 2, u: "block", n: "extra firm tofu" }],
    ["1 x 400g Tin Coconut Milk", { q: 1, u: "can", n: "Coconut Milk" }],
    ["3 × 100 g packs ramen noodles", { q: 3, u: "pack", n: "ramen noodles" }],
    ["2 casseaux de tomates cerises (551ml chacun), coupées en 2", { q: 2, u: "punnet", n: "tomates cerises" }],
    ["2 cans chickpeas (30 oz), drained and rinsed", { q: 2, max: null, u: "can", n: "chickpeas" }], // starter line rewritten 2026-09-30
    // metric first, spoon in parentheses
    ["45 ml (3 c. à soupe) Huile d’olive", { q: 45, u: "ml", n: "Huile d’olive" }],
    ["2,5 ml (½ c. à thé) de cannelle moulue", { q: 2.5, u: "ml" }],
    ["1 L (4 tasses) de bouillon de légumes", { q: 1, u: "l" }],
    // fractions
    ["¾ cup quinoa", { q: 0.75, u: "cup" }],
    ["2½ cup cooked brown lentils", { q: 2.5, u: "cup" }],
    ["1 ½ tasse de riz à risotto (Arborio)", { q: 1.5, u: "cup", n: "riz à risotto" }],
    ["1 1/2 tasse (45 g) de basilic", { q: 1.5, u: "cup", n: "basilic" }],
    ["¼ de tasse de noix de Grenoble", { q: 0.25, u: "cup", n: "noix de Grenoble" }],
    ["0.5 c. à thé de curcuma", { q: 0.5, u: "tsp" }],
    ["Jus de ½ lime", { q: 0.5, u: null, n: "lime" }],
    ["Jus d'un demi citron", { q: 0.5, u: null, n: "citron" }],
    ["Un demi-oignon rouge, tranché finement en demi-lunes", { q: 0.5, n: "oignon rouge" }],
    // ranges
    ["¼ à ½ tasse de bouillon de légumes (pour la purée de courge)", { q: 0.25, max: 0.5, u: "cup" }],
    ["1 à 1 1/2 tasse de lait", { q: 1, max: 1.5, u: "cup" }],
    ["20-25 feuilles de sauge", { q: 20, max: 25, u: "sheet", n: "sauge" }],
    ["7 ou 8 pommes de terre jaunes avec la pelure", { q: 7, max: 8, u: null }],
    ["2,5 ml à 5 ml (½ à 1 c. à thé) de poudre de chili", { q: 2.5, max: 5, u: "ml" }],
    ["170g-200g de champignons au choix (idéalement shiitake, pleurotes, etc)*", { q: 170, max: 200, u: "g" }],
    ["30-45 ml (2-3 c. à soupe) de fécule de maïs ou de fécule de tapioca", { q: 30, max: 45, u: "ml" }],
    ["Ail : 3-4 gousses d'ail émincées", { q: 3, max: 4, u: "clove" }],
    // quantity after the name
    ["Tofu extra ferme - 1 bloc de 450 g (1 lb)", { q: 1, u: "block", n: "Tofu extra ferme" }],
    ["Flocons de piment gochugaru (voir NOTES) - 5 à 10 ml (1 à 2 c. à thé), au goût", { q: 5, max: 10, u: "ml" }],
    ["Nouilles orientales (de type yet-ca-mein, voir p. 237) ou soba — 250 g (1/2 lb)", { q: 250, u: "g" }],
    // other units
    ["2 tbsp + 1 tsp avocado oil", { q: 7 / 3, u: "tbsp", n: "avocado oil" }],
    ["1 bout de gingembre d’un pouce, râpé finement", { q: 1, u: "inch", n: "gingembre" }],
    ["3inch piece ginger, finely chopped", { q: 3, u: "inch", n: "ginger" }],
    ["1 ½ pouce gingembre frais, râpé", { q: 1.5, u: "inch" }],
    ["1 botte de persil plat", { q: 1, u: "bunch", n: "persil plat" }],
    ["½ tête de chou-fleur (250 g) coupée en fleurons", { q: 0.5, u: "head" }],
    ["1 c à table d’huile végétale", { q: 1, u: "tbsp" }],
    ["1 c à café de gingembre haché", { q: 1, u: "tsp" }],
    ["3 c. soupe huile d'olive", { q: 3, u: "tbsp" }],
    ["Pinch Sea Salt", { q: 1, u: "pinch", n: "Sea Salt" }],
    // optional / to taste
    ["1 oignon vert haché pour décorer (facultatif)", { q: 1, opt: true }],
    ["1 Tsp Chilli Powder (Optional)", { q: 1, u: "tsp", opt: true }],
    ["Pour servir: fêta émiettée (optionnel)", { q: null, opt: true, n: "fêta émiettée" }],
    ["Poivre, au goût", { q: null, u: null, n: "Poivre", opt: false }],
    ["1 teaspoon salt, or more as needed", { q: 1, u: "tsp", n: "salt", opt: false }],
    ["small piece ginger", { q: null, u: null }], // no number in the source: nothing invented
  ] as const)("%s", (raw, want) => {
    expect(p(raw)).toMatchObject(want);
  });
});

describe("parser bugs (starter data affected; fixed ones are plain it)", () => {
  // Fixed 2026-09-30: OPTIONAL_RE now also matches the plural "facultatifs" (enoki were bought as required in
  // Ramen crémeux à la courge… de Loounie).
  it("plural (facultatifs) is optional", () => {
    expect(p("Champignons enokis (facultatifs)").opt).toBe(true);
  });

  // Fixed 2026-09-30: PART_OF_RE now knows "jus et zeste de", "le zeste et le jus de" and "d'un ½" (the ½ lemon
  // was lost and the list showed "Citron — au besoin" in Lasagne au pesto…, Plaque de pois chiches…).
  it("Jus et zeste de ½ citron -> 0.5 citron", () => {
    expect(p("Jus et zeste de ½ citron")).toMatchObject({ q: 0.5, n: "citron" });
  });
  it("Jus et zeste d'un ½ citron -> 0.5 citron", () => {
    expect(p("Jus et zeste d'un ½ citron")).toMatchObject({ q: 0.5, u: null, n: "citron" });
    expect(p("Jus d'un ½ citron")).toMatchObject({ q: 0.5, u: null, n: "citron" });
  });
  it("Le zeste et le jus de 1 citron -> 1 citron", () => {
    expect(p("Le zeste et le jus de 1 citron")).toMatchObject({ q: 1, n: "citron" });
  });

  // The "2 cans" count is ignored: 30 oz converted through the catalogue equivalence gives
  // 3 cans on the list instead of 2. Still a parser bug; the starter line (Marry Me Chickpeas) was rewritten
  // 2026-09-30 to "2 cans chickpeas (30 oz), drained and rinsed", checked in the table above.
  it.fails("30 oz canned chickpeas 2 cans -> 2 cans", () => {
    expect(p("30 oz canned chickpeas 2 cans, drained and rinsed")).toMatchObject({ q: 2, u: "can" });
  });

  // "+ 1 c. à soupe" is only added when it follows the unit directly, not after the name:
  // 60 ml counted instead of 75 ml (Soupe ramen maison végé).
  it.fails("¼ tasse de sauce soya + 1 c. à soupe -> 75 ml in total", () => {
    const r = p("¼ tasse de sauce soya + 1 c. à soupe pour la cuisson du tofu");
    expect(r.u).toBe("cup");
    expect(r.q! * 250).toBeCloseTo(75);
  });

  // "1 morceau de 1 pouce de gingembre" reads 1 piece and leaves "1 pouce" in the name,
  // whereas "1 bout de gingembre d'un pouce" gives 1 inch (Cari de patates douces…, Bol de tofu Satay).
  it.fails("1 morceau de ½ pouce de gingembre -> 0.5 inch", () => {
    expect(p("1 morceau de ½ pouce de gingembre, râpé")).toMatchObject({ q: 0.5, u: "inch", n: "gingembre" });
  });
});
