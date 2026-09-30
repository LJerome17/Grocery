// Rule-based parser for ingredient lines in French or English.
// "2 tasses de farine" -> { quantity: 2, unit: "cup", name: "farine" }
// "400g/1 packet Vegan Mince (or lentils)" -> { quantity: 400, unit: "g", name: "Vegan Mince", note: "1 packet; or lentils" }

import { cleanSpaces, decodeEntities, fold } from "./text";
import { UNIT_ALIASES, UNIT_BY_KEY } from "./units";

export type ParsedIngredient = {
  raw: string;
  section: string | null;
  quantity: number | null;
  quantityMax: number | null;
  unit: string | null;
  name: string;
  note: string | null;
  optional: boolean;
};

const FRACTION_CHARS: Record<string, string> = {
  "½": "1/2", "⅓": "1/3", "⅔": "2/3", "¼": "1/4", "¾": "3/4",
  "⅛": "1/8", "⅜": "3/8", "⅝": "5/8", "⅞": "7/8", "⅕": "1/5", "⅙": "1/6",
};

const NUM = String.raw`\d+\s+\d+\s*\/\s*\d+|\d+\s*\/\s*\d+|\d+(?:[.,]\d+)?`;
const QTY_RE = new RegExp(String.raw`^(${NUM})(?:\s*(?:-|–|à|to|or|ou)\s*(${NUM}))?`, "i");
const APPROX_RE = /^(?:\+\/-|±|~|about|approx\.?|around|environ)\s*/i;
const HALF_RE = /^(?:une? |a )?(?:demi|half)(?:-|\s+)(?:an? |d['’]une? |une? )?/i;
const WORD_ONE_RE = /^(?:a|an|one|un|une)\s+/i;
const PART_OF_RE = /^(?:le |la |the )?(jus|zeste|juice|zest)\s+(?:de\s+|d['’]\s*|of\s+)(?:la |le |l['’]|the )?/i;
// A package size such as "796 ml", "350 à 450 g".
const SIZE_AMOUNT = String.raw`\d+(?:[.,]\d+)?(?:\s*(?:à|-|–|to)\s*\d+(?:[.,]\d+)?)?\s*(?:ml|g|kg|l|oz|lb)`;
const CONTAINER_UNITS = new Set(["can", "pack", "block"]);
const SIZE_RE = /^(?:small|medium|large|big|extra[- ]large|heaped|heaping|level|rounded|generous|scant|petite?s?|moyens?|moyennes?|gros|grosses?|grande?s?)\b\s*/i;
const OPTIONAL_RE = /\b(?:optional|optionnel(?:le)?|facultati(?:f|ve))\b/i;
const TRAILING_NOTE_RE = /\s*\b(to taste|au go[uû]t|au besoin|as needed|for garnish|to serve|pour garnir|pour servir)\b.*$/i;
const BULLET_RE = /^[\s\-‐‑‒–—−•*▢□☐·]+/;
// "Pesto végétalien - 125 ml", "Nouilles soba — 250 g", "Fromage halloumi : un bloc" (quantity after the name).
const TAIL_QTY_RE = /^([^\d½¼¾⅓⅔]+?)\s+[-–—:]\s+((?:[\d½¼¾⅓⅔]|une?\s|a\s).*)$/i;
const SERVE_PREFIX_RE = /^(pour servir|to serve|for serving|garniture|garnish|toppings?)\s*:\s*/i;
// Units that make sense without a number in front ("Pinch nutmeg" -> 1 pinch).
const IMPLICIT_ONE_UNITS = new Set(["pinch", "handful", "bunch", "sprig", "pack", "can"]);

export function parseNumber(s: string): number {
  const t = s.replace(",", ".").trim();
  const mixed = t.match(/^(\d+)\s+(\d+)\s*\/\s*(\d+)$/);
  if (mixed) return Number(mixed[1]) + Number(mixed[2]) / Number(mixed[3]);
  const frac = t.match(/^(\d+)\s*\/\s*(\d+)$/);
  if (frac) return Number(frac[1]) / Number(frac[2]);
  return Number(t);
}

/** Try to read a unit at the start of `s`. Returns the unit key and the remaining text. */
function takeUnit(s: string): { unit: string; rest: string } | null {
  const f = fold(s);
  for (const { alias, key } of UNIT_ALIASES) {
    if (!f.startsWith(alias)) continue;
    const next = f.charAt(alias.length);
    if (next && /[a-z0-9]/.test(next)) continue; // "l" must not match "lime"
    let rest = s.slice(alias.length);
    rest = rest.replace(/^\.(?=\s|$)/, ""); // "c. à s." trailing dot
    return { unit: key, rest: rest.trimStart() };
  }
  return null;
}

export function parseIngredientLine(rawInput: string, section: string | null = null): ParsedIngredient {
  const raw = cleanSpaces(decodeEntities(rawInput)).replace(BULLET_RE, "");
  const notes: string[] = [];
  let s = raw.replace(/(\d)?(\s*)([½⅓⅔¼¾⅛⅜⅝⅞⅕⅙])/g, (_, d, sp, f) => (d ? `${d} ` : sp) + FRACTION_CHARS[f]);

  // Parenthesised text becomes a note (innermost first, for "((240g))").
  let before: string;
  do {
    before = s;
    s = s.replace(/\(([^()]*)\)/g, (_, inner) => {
      const t = inner.trim();
      if (t) notes.push(t);
      return " ";
    });
  } while (s !== before);
  s = cleanSpaces(s.replace(/[()]/g, " "));

  let optional = OPTIONAL_RE.test(raw);
  s = cleanSpaces(s.replace(OPTIONAL_RE, " ").replace(/,\s*$/, ""));
  for (let i = 0; i < notes.length; i++) {
    if (OPTIONAL_RE.test(notes[i])) {
      optional = true;
      notes[i] = cleanSpaces(notes[i].replace(OPTIONAL_RE, ""));
    }
  }

  const serve = s.match(SERVE_PREFIX_RE);
  if (serve) {
    notes.push(serve[1].toLowerCase());
    s = s.slice(serve[0].length);
  }
  const tail = s.match(TAIL_QTY_RE);
  if (tail) {
    // Keep the preparation after the name: "un bloc de 235g, tranché" + "Halloumi" -> "un bloc de 235g Halloumi, tranché".
    const [amount, ...prep] = tail[2].split(",");
    s = `${amount} ${tail[1]}${prep.length ? `,${prep.join(",")}` : ""}`;
  }

  // "Le jus d'une lime" -> buy a lime; "juice" kept as a note.
  const part = s.match(PART_OF_RE);
  if (part) {
    notes.push(part[1].toLowerCase());
    s = s.slice(part[0].length);
  }

  let quantity: number | null = null;
  let quantityMax: number | null = null;
  let unit: string | null = null;

  s = s.replace(APPROX_RE, "");
  const q = s.match(QTY_RE);
  const half = q ? null : s.match(HALF_RE);
  if (q) {
    quantity = parseNumber(q[1]);
    quantityMax = q[2] ? parseNumber(q[2]) : null;
    s = s.slice(q[0].length).trimStart();
  } else if (half) {
    quantity = 0.5;
    s = s.slice(half[0].length);
  } else if (WORD_ONE_RE.test(s)) {
    const after = s.replace(WORD_ONE_RE, "");
    // "a pinch of", "un bloc de"; French "un/une" also counts before a plain noun ("une pomme").
    if (takeUnit(after) || /^une?\s/i.test(s)) {
      quantity = 1;
      s = after;
    }
  }

  // "2 x 400g tins" / "3 × 100 g packs" -> keep "400g" as a note, then read "tins".
  const multi = s.match(/^[x×]\s*(\d+(?:[.,]\d+)?\s*(?:g|ml|oz|kg|l)\b)\s*/i);
  if (quantity !== null && multi) {
    notes.push(multi[1]);
    s = s.slice(multi[0].length);
  }

  // "2 16 ounce blocks tofu" -> 2 blocks, note "16 ounce".
  const packSize = quantity !== null ? s.match(new RegExp(String.raw`^(${NUM})\s*`)) : null;
  if (packSize) {
    const su = takeUnit(s.slice(packSize[0].length));
    const cu = su && UNIT_BY_KEY[su.unit].dim !== "count" ? takeUnit(su.rest) : null;
    if (su && cu && CONTAINER_UNITS.has(cu.unit)) {
      notes.push(cleanSpaces(s.slice(0, s.length - su.rest.length)));
      s = su.rest;
    }
  }

  let size = s.match(SIZE_RE);
  if (size) {
    notes.push(size[0].trim());
    s = s.slice(size[0].length);
  }

  // "¼ de tasse de noix"
  if (quantity !== null && !takeUnit(s) && /^(?:de\s+|d['’]\s*)/i.test(s)) {
    const stripped = s.replace(/^(?:de\s+|d['’]\s*)/i, "");
    if (takeUnit(stripped)) s = stripped;
  }

  const u = takeUnit(s);
  if (u && (quantity !== null || IMPLICIT_ONE_UNITS.has(u.unit))) {
    unit = u.unit;
    if (quantity === null) quantity = 1;
    const unitText = s.slice(0, s.length - u.rest.length).trim();
    s = u.rest;
    // "2 tbsp + 1 tsp oil" -> 2.33 tbsp
    const plus = s.match(new RegExp(String.raw`^\+\s*(${NUM})\s*`));
    const plusUnit = plus ? takeUnit(s.slice(plus[0].length)) : null;
    if (plus && plusUnit) {
      const a = UNIT_BY_KEY[unit];
      const b = UNIT_BY_KEY[plusUnit.unit];
      if (a.dim === b.dim && a.dim !== "count") {
        quantity += (parseNumber(plus[1]) * b.factor) / a.factor;
        s = plusUnit.rest;
      }
    }
    // Alternative measure: "400g/1 packet ..." or "1 cup / 250 ml ..."
    const alt = s.match(new RegExp(String.raw`^\/\s*(?:${NUM})\s*`));
    if (alt) {
      s = s.slice(alt[0].length);
      const altUnit = takeUnit(s);
      notes.push(cleanSpaces(alt[0].slice(1) + (altUnit ? s.slice(0, s.length - altUnit.rest.length) : "")));
      if (altUnit) s = altUnit.rest;
    }
    // "14 oz can chickpeas" -> 1 can, note "14 oz".
    const containerAfter = takeUnit(s);
    if (containerAfter && CONTAINER_UNITS.has(containerAfter.unit) && !CONTAINER_UNITS.has(unit)) {
      notes.push(`${q ? q[0].trim() : ""} ${unitText}`.trim());
      quantity = 1;
      quantityMax = null;
      unit = containerAfter.unit;
      s = containerAfter.rest;
    }
    s = s.replace(/^(?:of|de|du|des)\s+/i, "").replace(/^d['’]\s*/i, "");
    // Container size: "1 boîte de 796 ml de tomates" -> note "796 ml", name "tomates".
    const container = s.match(new RegExp(String.raw`^(${SIZE_AMOUNT})\s+(?:(?:of|de|du|des)\s+|d['’]\s*)?`, "i"));
    if (container) {
      notes.push(container[1]);
      s = s.slice(container[0].length);
    }
  }

  size = s.match(SIZE_RE);
  if (size && quantity !== null) {
    notes.push(size[0].trim());
    s = s.slice(size[0].length);
  }

  // "tofu de 315 g" -> note "315 g".
  const sizeTail = s.match(new RegExp(String.raw`\s+(?:de|of)\s+(${SIZE_AMOUNT})(?=\s|,|$)`, "i"));
  if (sizeTail && sizeTail.index! > 0) {
    notes.push(sizeTail[1]);
    s = s.slice(0, sizeTail.index) + s.slice(sizeTail.index! + sizeTail[0].length);
  }

  // Everything after the first comma is preparation detail.
  const comma = s.indexOf(",");
  if (comma > 0) {
    notes.unshift(s.slice(comma + 1).trim());
    s = s.slice(0, comma);
  }
  const trailing = s.match(TRAILING_NOTE_RE);
  if (trailing && trailing.index! > 0) {
    notes.push(trailing[0].trim());
    s = s.slice(0, trailing.index);
  }

  const name = cleanSpaces(s).replace(/[.;:,]+$/, "");
  const note = notes.map((n) => n.trim()).filter(Boolean).join("; ") || null;
  return { raw, section, quantity, quantityMax, unit, name, note, optional };
}

export type SourceLine = { text: string; bold?: boolean };

/** A line is a section header ("Béchamel Sauce", "Pour la sauce :") rather than an ingredient. */
export function isSectionHeader(line: SourceLine): boolean {
  const t = cleanSpaces(line.text);
  if (!t) return false;
  if (/:\s*$/.test(t) && t.length < 60) return true;
  if (/^(for the|pour (le|la|les|l['’]))\b/i.test(t) && t.split(" ").length <= 6) return true;
  if (line.bold && !/\d/.test(t) && t.split(" ").length <= 5) return true;
  return false;
}

/** Parse a block of ingredient lines, tracking section headers. */
export function parseIngredientBlock(lines: (SourceLine | string)[]): ParsedIngredient[] {
  let section: string | null = null;
  const out: ParsedIngredient[] = [];
  for (const l of lines) {
    const line = typeof l === "string" ? { text: l } : l;
    const text = cleanSpaces(decodeEntities(line.text));
    if (!text) continue;
    if (isSectionHeader({ ...line, text })) {
      section = text.replace(/:\s*$/, "").replace(/^(for the|pour (le|la|les|l['’]))\s*/i, "").trim() || null;
      continue;
    }
    const p = parseIngredientLine(text, section);
    if (p.name) out.push(p);
  }
  return out;
}
