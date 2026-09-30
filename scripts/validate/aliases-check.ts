// Assert that tricky ingredient names map to the intended catalogue item, and sanity-check the catalogue.
// Usage: npx tsx scripts/validate/aliases-check.ts
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildAliasIndex, matchIngredient } from "../../src/lib/catalog";
import { nameKey } from "../../src/lib/text";

const ROOT = join(__dirname, "..", "..");
type Item = { name: string; name_en?: string; aliases: string[] };
const catalog = JSON.parse(readFileSync(join(ROOT, "data", "catalog.json"), "utf8")) as { ingredients: Item[] };
const index = buildAliasIndex(catalog.ingredients.map((i) => ({ id: i.name, aliases: i.aliases })));

const CASES: [string, string][] = [
  // New / fixed mappings
  ["Flocons de piment gochugaru", "Piment gochugaru"],
  ["gingembre moulu", "Gingembre moulu"],
  ["riz brun", "Riz brun"],
  ["riz brun ou quinoa", "Riz brun"],
  ["huile de truffe", "Huile de truffe"],
  ["red pepper", "Poivron rouge"],
  ["yellow pepper", "Poivron jaune"],
  ["poivron jaune", "Poivron jaune"],
  ["lait de cajou", "Boisson végétale"],
  ["cashew milk", "Boisson végétale"],
  ["vinaigre de vin blanc", "Vinaigre de vin blanc"],
  ["white wine vinegar", "Vinaigre de vin blanc"],
  ["rice wine vinegar", "Vinaigre de riz"],
  ["pâte de cari vert", "Pâte de cari vert"],
  ["green curry paste", "Pâte de cari vert"],
  ["pâtes de riz", "Nouilles de riz"],
  ["feuilles de riz", "Galettes de riz"],
  ["brown rice", "Riz brun"],
  ["vegan feta", "Fromage végane râpé"],
  ["vegan cheddar", "Fromage végane râpé"],
  ["parmesan végétalien", "Parmesan végane"],
  ["yogourt de coco", "Yogourt végétal"],
  ["vegan fish sauce", "Sauce de poisson végétalienne"],
  ["mushroom oyster sauce", "Sauce aux huîtres végétale (champignons)"],
  ["white kidney beans", "Haricots blancs (conserve)"],
  ["lentilles vertes en conserve", "Lentilles brunes (conserve)"],
  ["chilli flakes", "Flocons de piment fort"],
  ["chipotle en poudre", "Chipotle en poudre"],
  ["tomates en conserve", "Tomates entières (conserve)"],
  ["canned tomatoes", "Tomates entières (conserve)"],
  ["romarin frais", "Romarin frais"],
  ["thyme sprigs", "Thym frais"],
  ["sauge séchée", "Sauge séchée"],
  ["menthe séchée", "Menthe séchée"],
  ["sucre brun", "Cassonade"],
  ["sugar snap peas", "Pois mange-tout"],
  ["snow peas", "Pois mange-tout"],
  ["farine de pois chiche", "Farine de pois chiches"],
  ["farine de maïs", "Farine de maïs"],
  ["tortillas de maïs", "Tortillas de maïs"],
  ["corn tortillas", "Tortillas de maïs"],
  ["eau de coco", "Eau de coco"],
  ["feuilles de lime kaffir", "Feuilles de lime kaffir"],
  ["lemon grass", "Citronnelle"],
  ["mélasse de grenade", "Mélasse de grenade"],
  ["crème de champignons", "Crème de champignons (conserve)"],
  ["vegetable bouillon paste", "Base de bouillon (pâte)"],
  // Must not regress
  ["poivre noir", "Poivre noir"],
  ["sel et poivre", "Sel"],
  ["black pepper", "Poivre noir"],
  ["poivron rouge", "Poivron rouge"],
  ["gingembre frais", "Gingembre"],
  ["gingembre", "Gingembre"],
  ["riz blanc", "Riz blanc"],
  ["huile d'olive", "Huile d'olive"],
  ["vinaigre de vin rouge", "Vinaigre de vin rouge"],
  ["pâte de cari rouge", "Pâte de cari rouge"],
  ["lait", "Lait"],
  ["feta", "Feta"],
  ["cheddar", "Cheddar fort"],
  ["tomate", "Tomate"],
  ["tomates cerises", "Tomates cerises"],
  ["bouillon de légumes", "Bouillon de légumes"],
  ["vegetable broth", "Bouillon de légumes"],
  ["sucre", "Sucre"],
  ["petits pois surgelés", "Petits pois surgelés"],
  ["farine tout usage", "Farine tout usage"],
  ["tortillas", "Tortillas de blé"],
  ["lime", "Lime"],
  ["citron", "Citron"],
  ["grenade", "Grenade"],
  ["champignons blancs", "Champignons blancs"],
  ["thym séché", "Thym séché"],
  ["romarin séché", "Romarin séché"],
  ["menthe fraîche", "Menthe fraîche"],
  ["sauge fraîche", "Sauge fraîche"],
  ["sauce soya", "Sauce soya"],
];

let fail = 0;
for (const [input, want] of CASES) {
  const got = matchIngredient(input, index);
  if (got !== want) {
    fail++;
    console.log(`FAIL  "${input}" -> ${got ?? "null"} (attendu: ${want})`);
  }
}

// Every item has name_en; no alias key claimed by two items (buildAliasIndex keeps only the last).
const owner = new Map<string, string>();
for (const i of catalog.ingredients) {
  if (!i.name_en) {
    fail++;
    console.log(`FAIL  pas de name_en: ${i.name}`);
  }
  for (const a of i.aliases) {
    const k = nameKey(a);
    const prev = owner.get(k);
    if (prev && prev !== i.name) {
      fail++;
      console.log(`FAIL  alias "${k}" en double: ${prev} / ${i.name}`);
    }
    owner.set(k, i.name);
  }
}

console.log(`${CASES.length} cas, ${catalog.ingredients.length} items, ${fail} échec(s)`);
process.exit(fail ? 1 : 0);
