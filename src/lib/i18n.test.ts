import { afterEach, describe, expect, it } from "vitest";
import { aisleLabel } from "./aisles";
import { messageFr } from "./erreur";
import { setLang, tr } from "./i18n";
import { buildShoppingList } from "./shopping";
import { formatNumber, unitLabel } from "./units";

afterEach(() => setLang("fr"));

describe("English households", () => {
  it("translates the interface, units, aisles and numbers", () => {
    setLang("en");
    expect(tr("Semaine", "Week")).toBe("Week");
    expect(unitLabel("cup", 2)).toBe("cups");
    expect(unitLabel("tbsp", 1)).toBe("tbsp");
    expect(aisleLabel("fruits-legumes")).toBe("Produce");
    expect(formatNumber(2.6)).toBe("2.6");
  });

  it("writes the grocery list with the English catalogue names", () => {
    setLang("en");
    const catalog = new Map([["k", { id: "k", name: "Chou frisé (kale)", name_en: "Kale", aisle: "fruits-legumes", pantry: false }]]);
    const ing = (quantity: number | null, quantity_max: number | null = null) => ({ ingredient_id: "k", quantity, quantity_max, unit: null, name: "kale", optional: false });
    const [line] = buildShoppingList([{ title: "A", factor: 1, ingredients: [ing(1, 2)] }, { title: "B", factor: 1, ingredients: [ing(1)] }], catalog);
    expect(line).toMatchObject({ label: "Kale", quantityText: "2 to 3" });
    const [none] = buildShoppingList([{ title: "A", factor: 1, ingredients: [ing(null)] }], catalog);
    expect(none.quantityText).toBe("as needed");
  });

  it("translates server messages", () => {
    setLang("en");
    expect(messageFr(new Error("Le site a refusé la lecture (HTTP 403). Utilisez plutôt « coller le texte ».")))
      .toBe("This site won't let the recipe be read (HTTP 403). Use “Paste the text” instead."); // wording changed 2026-09-30
    expect(messageFr(new Error("Invalid login credentials"))).toBe("Wrong username or password.");
  });

  it("keeps French unchanged", () => {
    expect(unitLabel("cup", 2)).toBe("tasses");
    expect(formatNumber(2.6)).toBe("2,6");
    expect(aisleLabel("fruits-legumes")).toBe("Fruits et légumes");
  });
});
