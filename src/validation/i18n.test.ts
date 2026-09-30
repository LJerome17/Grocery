// Validation of the French / English outputs of the shared helpers (units, aisles, numbers, messages,
// catalogue names, seasons, dish types, proteins). The language is reset to French after each test.
import { afterEach, describe, expect, it } from "vitest";
import { aisleLabel, AISLES } from "../lib/aisles";
import { catalogName, dishTypeLabel, DISH_TYPES, proteinLabel, PROTEINS } from "../lib/db";
import { messageFr, UserMessage } from "../lib/erreur";
import { lang, locale, plural, setLang, tr } from "../lib/i18n";
import { seasonLabel, type Season } from "../lib/planner";
import { formatBase, formatNumber, unitLabel, UNITS } from "../lib/units";
import catalog from "../../data/catalog.json";

afterEach(() => setLang("fr"));

describe("tr, plural, locale", () => {
  it("French by default", () => {
    expect(lang()).toBe("fr");
    expect(tr("Semaine", "Week")).toBe("Semaine");
    expect(locale()).toBe("fr-CA");
    expect(plural(0, ["recette", "recettes"], ["recipe", "recipes"])).toBe("0 recette");
    expect(plural(1, ["recette", "recettes"], ["recipe", "recipes"])).toBe("1 recette");
    expect(plural(2, ["recette", "recettes"], ["recipe", "recipes"])).toBe("2 recettes");
  });
  it("English", () => {
    setLang("en");
    expect(tr("Semaine", "Week")).toBe("Week");
    expect(locale()).toBe("en-CA");
    expect(plural(0, ["recette", "recettes"], ["recipe", "recipes"])).toBe("0 recipes");
    expect(plural(1, ["recette", "recettes"], ["recipe", "recipes"])).toBe("1 recipe");
    expect(plural(3, ["recette", "recettes"], ["recipe", "recipes"])).toBe("3 recipes");
  });
});

describe("units", () => {
  it("French labels", () => {
    expect(unitLabel("tsp", 1)).toBe("c. à thé");
    expect(unitLabel("tbsp", 2)).toBe("c. à soupe");
    expect(unitLabel("cup", 1)).toBe("tasse");
    expect(unitLabel("cup", 3)).toBe("tasses");
    // OQLF (2026-09-30): singular below 2, plural from 2.
    expect(unitLabel("cup", 1.5)).toBe("tasse");
    expect(unitLabel("cup", 2)).toBe("tasses");
    expect(unitLabel("can", 2)).toBe("boîtes");
    expect(unitLabel("punnet", 1)).toBe("barquette");
    expect(unitLabel("clove", 2)).toBe("gousses");
    expect(unitLabel("l", 2)).toBe("L");
    expect(unitLabel(null, 2)).toBe("");
  });
  it("English labels", () => {
    setLang("en");
    expect(unitLabel("tsp", 2)).toBe("tsp");
    expect(unitLabel("tbsp", 1)).toBe("tbsp");
    expect(unitLabel("cup", 1)).toBe("cup");
    expect(unitLabel("cup", 2)).toBe("cups");
    expect(unitLabel("cup", 1.5)).toBe("cups"); // English: plural above 1 (2026-09-30)
    expect(unitLabel("can", 2)).toBe("cans");
    expect(unitLabel("punnet", 2)).toBe("containers");
    expect(unitLabel("portion", 2)).toBe("servings");
    expect(unitLabel("floz", 1)).toBe("fl oz");
    expect(unitLabel("inch", 2)).toBe("inches");
    expect(unitLabel("g", 500)).toBe("g");
  });
  it("every unit with a French word has an English label that is not French", () => {
    setLang("en");
    for (const u of UNITS) {
      const en = [unitLabel(u.key, 1), unitLabel(u.key, 2)];
      for (const s of en) expect(s, u.key).not.toMatch(/[àâçéèêëîïôûù]/);
    }
  });
});

describe("numbers", () => {
  it("French: decimal comma, fractions", () => {
    expect(formatNumber(2.6)).toBe("2,6");
    expect(formatNumber(1.5)).toBe("1 ½");
    expect(formatNumber(0.25)).toBe("¼");
    expect(formatNumber(3)).toBe("3");
    expect(formatBase(1500, "g")).toBe("1,5 kg"); // kg and L in decimals, never fractions (changed 2026-09-30)
    expect(formatBase(1200, "ml")).toBe("1,2 L");
    expect(formatBase(2, "can")).toBe("2 boîtes");
    expect(formatBase(1.5, "cup")).toBe("1 ½ tasse"); // OQLF: singular below 2
  });
  it("English: decimal point, fractions", () => {
    setLang("en");
    expect(formatNumber(2.6)).toBe("2.6");
    expect(formatNumber(1.5)).toBe("1 ½");
    expect(formatNumber(2 / 3)).toBe("⅔");
    expect(formatBase(1200, "ml")).toBe("1.2 L");
    expect(formatBase(2500, "g")).toBe("2.5 kg");
    expect(formatBase(2, "can")).toBe("2 cans");
    expect(formatBase(1, "clove")).toBe("1 clove");
  });
});

describe("aisles", () => {
  it("French", () => {
    expect(aisleLabel("fruits-legumes")).toBe("Fruits et légumes");
    expect(aisleLabel("collations")).toBe("Croustilles et collations");
    expect(aisleLabel("inconnu")).toBe("Autre");
  });
  it("English", () => {
    setLang("en");
    expect(aisleLabel("fruits-legumes")).toBe("Produce");
    expect(aisleLabel("laitiers")).toBe("Dairy and eggs");
    expect(aisleLabel("surgeles")).toBe("Frozen");
    for (const [k] of AISLES) expect(aisleLabel(k), k).not.toMatch(/[àâçéèêëîïôûùœ]/);
  });
  // Fixed 2026-09-30 (src/lib/aisles.ts): an unknown aisle key now falls back to "Other" in English (was the French "Autre").
  it("English fallback for an unknown aisle is 'Other'", () => {
    setLang("en");
    expect(aisleLabel("aucun")).toBe("Other");
  });
});

describe("messages", () => {
  it("French", () => {
    expect(messageFr(new Error("Invalid login credentials"))).toBe("Nom d'utilisateur ou mot de passe incorrect.");
    expect(messageFr(new Error("Lien invalide."))).toBe("Lien invalide.");
    expect(messageFr(new UserMessage("Déjà écrit."))).toBe("Déjà écrit.");
    expect(messageFr({ message: "new row violates row-level security policy" })).toBe("Action non autorisée pour ce foyer.");
  });
  it("English", () => {
    setLang("en");
    expect(messageFr(new Error("Failed to fetch"))).toBe("No Internet connection, or the server isn't responding.");
    expect(messageFr(new Error("Non connecté."))).toBe("Not signed in.");
    expect(messageFr(new Error("Trop de redirections."))).toBe("Too many redirects.");
    expect(messageFr(new Error("Lien invalide : seules les adresses web sont acceptées."))).toBe("Invalid link: only web addresses are accepted.");
    expect(messageFr(new Error("Le site a refusé la lecture (HTTP 404). Utilisez plutôt « coller le texte »."))).toBe("This site won't let the recipe be read (HTTP 404). Use “Paste the text” instead.");
    expect(messageFr(new Error("Session expirée, reconnectez-vous."))).toBe("Session expired: reload the page.");
  });
});

describe("catalogue names", () => {
  const items = (catalog as { ingredients: { name: string; name_en?: string }[] }).ingredients;
  it("every item has an English name, without French accents", () => {
    for (const i of items) {
      expect(i.name_en, i.name).toBeTruthy();
      expect(i.name_en!.replace(/Jalapeño|Tourtière|Herbes de Provence|purée/g, ""), i.name).not.toMatch(/[àâçéèêëîïôûùœ]/);
    }
  });
  it("catalogName follows the language", () => {
    const green = items.find((i) => i.name === "Oignon vert")!;
    expect(catalogName(green)).toBe("Oignon vert");
    setLang("en");
    expect(catalogName(green)).toBe("Green onions");
    expect(catalogName({ name: "Article maison", name_en: null })).toBe("Article maison");
  });
});

describe("seasons, dish types, proteins", () => {
  const seasons: Season[] = ["printemps", "ete", "automne", "hiver"];
  it("French", () => {
    expect(seasons.map(seasonLabel)).toEqual(["Printemps", "Été", "Automne", "Hiver"]);
    expect(dishTypeLabel("mijoté")).toBe("mijoté");
    expect(proteinLabel("pois chiches")).toBe("pois chiches");
  });
  it("English", () => {
    setLang("en");
    expect(seasons.map(seasonLabel)).toEqual(["Spring", "Summer", "Fall", "Winter"]);
    expect(dishTypeLabel("mijoté")).toBe("stew");
    expect(dishTypeLabel("pain plat")).toBe("flatbread");
    expect(proteinLabel("pois chiches")).toBe("chickpeas");
    expect(proteinLabel("œufs")).toBe("eggs");
    expect(proteinLabel("haricots rouges")).toBe("red kidney beans");
    expect(proteinLabel("haché végé")).toBe("plant-based ground round");
    for (const d of DISH_TYPES) expect(dishTypeLabel(d), d).not.toMatch(/[àâçéèêëîïôûùœ]/);
    for (const p of PROTEINS) expect(proteinLabel(p), p).not.toMatch(/[àâçéèêëîïôûùœ]/);
  });
});
