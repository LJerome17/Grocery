import { describe, expect, it } from "vitest";
import catalog from "../../data/catalog.json";
import { matchFlyerItem } from "./flyer";
import { nameKey } from "./text";

const aliases = new Map<string, string>();
for (const i of catalog.ingredients) for (const a of i.aliases) aliases.set(nameKey(a), i.name);

describe("matchFlyerItem", () => {
  it.each([
    ["TOFU EXTRA FERME FONTAINE SANTÉ | EXTRA FIRM TOFU, 400 G", ["Tofu extra-ferme"]],
    ["LAITUE ICEBERG | ICEBERG LETTUCE", ["Laitue iceberg"]],
    ["CAROTTES OU OIGNONS JAUNES DÉLICES DU MARCHÉ, SAC DE 3 LB,", ["Carotte", "Oignon jaune"]],
    ["POIVRONS VERTS OU ASSORTIS NATURELLEMENT IMPARFAITS SANS NOM®, SAC DE 2,5 LB", ["Poivron vert"]],
    ["GROS AVOCATS | LARGE AVOCADOS", ["Avocat"]],
    ["POMMES CORTLAND OU MCINTOSH", ["Pomme"]],
  ])("%s", (name, expected) => {
    expect(matchFlyerItem(name, aliases).sort()).toEqual([...expected].sort());
  });

  it.each([
    "PURÉE DE POMMES DE TERRE IDAHOAN | MASHED POTATOES, 113 G",
    "NETTOYANT POUR LE CORPS IRISH SPRING OU SOFTSOAP, 591 ML OU PAINS DE SAVON, 6X104 G IRISH SPRING",
    "NOURRITURE SÈCHE POUR CHATS NUTRITION PREMIÈRE PC, 2 kg",
    "PLATS CUISINÉS HEALTHY CHOICE, 259-306 g",
  ])("ignores %s", (name) => {
    expect(matchFlyerItem(name, aliases)).toEqual([]);
  });
});
