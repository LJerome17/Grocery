// Checks every ingredient line of the starter recipes: raw text vs parsed quantity, range, unit, optional.
// Usage: npx tsx scripts/validate/quantities.ts [--all]   (--all: dump every line, not only the flagged ones)
import { readFileSync } from "node:fs";
import { join } from "node:path";

type Ing = {
  raw: string; quantity: number | null; quantity_max: number | null; unit: string | null;
  name: string; note: string | null; optional: boolean; section: string | null; catalog: string | null;
};
type Recipe = { title: string; servings: number | null; ingredients: Ing[] };

const ROOT = join(__dirname, "..", "..");
const recipes = JSON.parse(readFileSync(join(ROOT, "public", "starter", "recipes.json"), "utf8")) as Recipe[];
const showAll = process.argv.includes("--all");

const FR: Record<string, number> = { "½": 0.5, "¼": 0.25, "¾": 0.75, "⅓": 1 / 3, "⅔": 2 / 3, "⅛": 0.125 };
const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const near = (a: number | null, b: number | null) => a !== null && b !== null && Math.abs(a - b) < 0.011;

/** Read a number token: "1 1/2", "1/2", "1½", "½", "2,5", "2.5". */
const NUM_TOKEN = /(\d+\s+\d+\/\d+|\d+\/\d+|\d+\s*[½¼¾⅓⅔⅛]|[½¼¾⅓⅔⅛]|\d+(?:[.,]\d+)?)/g;
function val(t: string): number {
  t = t.trim();
  let m = t.match(/^(\d+)\s+(\d+)\/(\d+)$/);
  if (m) return +m[1] + +m[2] / +m[3];
  m = t.match(/^(\d+)\/(\d+)$/);
  if (m) return +m[1] / +m[2];
  m = t.match(/^(\d+)?\s*([½¼¾⅓⅔⅛])$/);
  if (m) return (m[1] ? +m[1] : 0) + FR[m[2]];
  return Number(t.replace(",", "."));
}
const numbersIn = (s: string | null) => (s ? [...s.matchAll(NUM_TOKEN)].map((m) => val(m[1])) : []);

// Unit words in the raw text -> expected key (checked on the text right after the leading quantity).
const UNIT_WORDS: [RegExp, string][] = [
  [/^(c\.?\s*a\.?\s*(soupe|s\b|table)|cuill[eè]res?\s+a\s+(soupe|table)|tbsp?s?\b|tbl|tablespoons?)/, "tbsp"],
  [/^(c\.?\s*a\.?\s*(the|cafe|c\b|t\b)|cuill[eè]res?\s+a\s+(the|cafe)|tsps?\b|teaspoons?)/, "tsp"],
  [/^(tasses?|cups?)\b/, "cup"],
  [/^(ml|millilitres?)\b/, "ml"], [/^(l|litres?)\b/, "l"], [/^(g|gr|grammes?|grams?)\b/, "g"], [/^(kg)\b/, "kg"],
  [/^(lbs?|livres?|pounds?)\b/, "lb"], [/^(oz|onces?|ounces?)\b/, "oz"],
  [/^(boites?|cans?|tins?|conserves?)\b/, "can"], [/^(gousses?|cloves?)\b/, "clove"], [/^(bottes?|bunch(es)?|bouquets?)\b/, "bunch"],
  [/^(pouces?|po|inch(es)?)\b/, "inch"], [/^(paquets?|packs?|packets?|packages?|sachets?|sacs?|bags?)\b/, "pack"],
  [/^(pincees?|pinch(es)?)\b/, "pinch"], [/^(blocs?|blocks?)\b/, "block"], [/^(tranches?|slices?)\b/, "slice"],
  [/^(branches?|tiges?|stalks?)\b/, "stalk"], [/^(brins?|sprigs?)\b/, "sprig"], [/^(tetes?|heads?)\b/, "head"],
  [/^(poignees?|handfuls?)\b/, "handful"], [/^(feuilles?|sheets?|leaves)\b/, "sheet"], [/^(cubes?)\b/, "cube"],
  [/^(morceaux?|pieces?|bouts?)\b/, "piece"], [/^(portions?|servings?)\b/, "portion"], [/^(boules?|balls?)\b/, "ball"],
  [/^(barquettes?|casseaux?|contenants?|pints?)\b/, "punnet"], [/^(berlingots?|cartons?)\b/, "carton"],
];
const OPT_RE = /\b(facultati(f|ve)s?|optionnel(le)?s?|optional)\b/;
const TASTE_RE = /\b(au gout|to taste|au besoin|as needed)\b/;
const LEAD_RE = /^\s*(?:[-•*]\s*)?(?:environ\s+|about\s+|~\s*)?(\d+\s+\d+\/\d+|\d+\/\d+|\d+\s*[½¼¾⅓⅔⅛]|[½¼¾⅓⅔⅛]|\d+(?:[.,]\d+)?)\s*(?:(?:à|a|-|–|to|or|ou)\s*(\d+\s+\d+\/\d+|\d+\/\d+|\d+\s*[½¼¾⅓⅔⅛]|[½¼¾⅓⅔⅛]|\d+(?:[.,]\d+)?))?\s*(.*)$/i;

let total = 0;
let flaggedCount = 0;
const byKind: Record<string, number> = {};
for (const r of recipes) {
  const out: string[] = [];
  for (const i of r.ingredients) {
    total++;
    const flags: string[] = [];
    const raw = i.raw;
    const f = fold(raw);
    // "Tofu ferme - 225 g", "Ail : 3 gousses", "Jus de ½ lime", "+/- 4 tasses": look at the amount part.
    const amountPart = raw
      .replace(/^\s*\+\/-\s*/, "")
      .replace(/^(?:le |la )?(?:jus|zeste)\s+(?:de|d['’])\s*/i, "")
      .replace(/^(?:garnitures?\s*:\s*)/i, "")
      .replace(/^[^\d½¼¾⅓⅔]+?(?:\s+[-–—]|\s*:)\s+(?=[\d½¼¾⅓⅔])/, "");
    const lead = amountPart.match(LEAD_RE);
    if (lead) {
      const q = val(lead[1]);
      const qmax = lead[2] ? val(lead[2]) : null;
      if (i.quantity === null) flags.push("QTY-NULL");
      else if (!near(i.quantity, q)) {
        // "1 boîte (540 ml)" and "2 x 400 g" are fine when a container is the unit.
        flags.push(`QTY ${q}≠${i.quantity}`);
      }
      if (qmax !== null && !near(i.quantity_max, qmax)) flags.push(`RANGE max ${qmax}≠${i.quantity_max}`);
      if (qmax === null && i.quantity_max !== null) {
        // range after the unit ("2,5 ml à 5 ml")
        const rest = lead[3];
        if (!/^\S+\.?\s*(à|a|-|–|to|ou|or)\s*\d/i.test(fold(rest).replace(/c\. a (soupe|the)/, "u"))) flags.push(`MAX? ${i.quantity_max}`);
      }
      // unit check on text after the leading quantity
      const after = fold(lead[3]).replace(/^(de |d'|d’|of )/, "").replace(/^\(.*?\)\s*/, "")
        .replace(/^(small|medium|large|heaped|heaping|petites?|grosses?|gros|grandes?|moyens?|moyennes?)\s+/, "").replace(/^(de |d'|d’|of )/, "");
      const hit = UNIT_WORDS.find(([re]) => re.test(after));
      if (hit && hit[1] !== i.unit) flags.push(`UNIT raw=${hit[1]} parsed=${i.unit}`);
      if (!hit && i.unit && !["can", "pack", "block", "inch"].includes(i.unit)) flags.push(`UNIT? parsed=${i.unit}`);
    } else if (i.quantity !== null && !/^(une?|a|an|one|demi|half|le jus|la moitie|pinch|pincee|juice|zest|le zeste)\b/i.test(f.trim())) {
      flags.push(`QTY-FROM-NOWHERE ${i.quantity}`);
    }
    // every number in raw must appear in quantity / max / note (or name)
    const known = [i.quantity, i.quantity_max, ...numbersIn(i.note), ...numbersIn(i.name)];
    for (const n of numbersIn(raw)) {
      if (!known.some((k) => near(k, n)) && !(i.unit === "inch" && i.quantity !== null)) flags.push(`LOST ${n}`);
    }
    if (i.quantity === null && numbersIn(i.name).length) flags.push("QTY-IN-NAME");
    if (/\+\s*\d/.test(i.name)) flags.push("PLUS-IN-NAME");
    // "Garnitures: 4 oeufs, maïs, coriandre" is one line for several grocery items: only the first one is bought.
    const listed = raw.replace(/^(garnitures?|pour servir)\s*:\s*/i, "");
    if (listed !== raw && /,| et /.test(listed.replace(/\(.*?\)/g, "")) && !/ ou /.test(listed)) flags.push("MULTI-ITEM");
    if (i.unit === "oz" && /\d+\s*(cans?|boites?)\b/i.test(f)) flags.push("CAN-COUNT-IGNORED");
    if (i.note && /\d\s*(c\. a (soupe|the)|tasses?)/i.test(fold(i.note)) && i.unit === "ml" && i.raw.match(/^\d+ ml de/)) flags.push("NOTE-UNSCALED?");
    if (OPT_RE.test(f) && !i.optional) flags.push("OPT-MISSING");
    if (i.optional && !OPT_RE.test(f)) flags.push("OPT-EXTRA");
    if (TASTE_RE.test(f) && i.quantity !== null) flags.push("TASTE+QTY");
    if (/[½¼¾⅓⅔]/.test(raw) || /\d\s+\d\/\d/.test(raw)) flags.push("frac");
    const real = flags.filter((x) => x !== "frac");
    for (const x of real) byKind[x.split(" ")[0]] = (byKind[x.split(" ")[0]] ?? 0) + 1;
    if (real.length) flaggedCount++;
    if (real.length || showAll) {
      out.push(`  ${real.length ? "!!" : "  "} ${raw} | q=${i.quantity} | max=${i.quantity_max} | u=${i.unit} | n=${i.name} | opt=${i.optional} | note=${i.note ?? ""}${real.length ? `   <= ${flags.join(", ")}` : ""}`);
    }
  }
  if (out.length) console.log(`\n## ${r.title} (portions ${r.servings})\n${out.join("\n")}`);
}
console.log(`\n${recipes.length} recettes, ${total} lignes, ${flaggedCount} lignes signalées`, byKind);
