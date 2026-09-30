// Parse a recipe pasted as plain text (copied from a page, a note, a PDF...).
// Expected shape, all parts optional: title, "Serves: 3", "Ingredients" block, "Method" block.

import type { ImportedRecipe } from "./importRecipe";
import { parseServings } from "./importRecipe";
import { isSectionHeader, parseIngredientLine, type ParsedIngredient } from "./parseIngredient";
import { cleanSpaces } from "./text";

const INGREDIENTS_RE = /^ingr[ée]dients?\s*:?$/i;
const METHOD_RE = /^(method|instructions?|directions?|pr[ée]paration|[ée]tapes|steps|mode de pr[ée]paration|before you start|avant de commencer)\s*:?$/i;
const NOTES_RE = /^(notes?|tips|notes? \/ tips|astuces?|conseils?)\s*:?$/i;
const SERVINGS_LINE_RE = /^[~\s]*(?:serves|servings|yield|makes|portions?|rendement|pour|for)\b.*\d|^\s*[~\s]*\d+\s*(?:servings|portions|personnes)/i;
const STEP_RE = /^\s*(?:\d+[.)]|étape \d+|step \d+)\s*/i;
const QTY_START_RE = /^[\s\-•*]*(?:[\d½¼¾⅓⅔⅛]|a |an |une? )/i;
// Words that mark a sub-list inside the ingredients ("Dressing", "Salad base", "Pour la sauce").
const HEADER_WORD_RE = /\b(sauce|dressing|vinaigrette|marinade|garniture|garnish|toppings?|crumble|base|filling|farce|broth|bouillon|vegetables|légumes|protein|protéines?|pâte|dough|glaze|glaçage|assemblage|salade|salad|fried rice|riz frit|pour servir|to serve)\b/i;

function isTextSectionHeader(line: string, prevBlank: boolean, next: string | undefined): boolean {
  if (isSectionHeader({ text: line })) return true;
  if (/\d|,/.test(line) || line.split(/\s+/).length > 4) return false;
  if (HEADER_WORD_RE.test(line)) return true;
  return prevBlank && !!next && QTY_START_RE.test(next);
}

export function parseRecipeText(text: string): ImportedRecipe {
  const lines = text.replace(/\r/g, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  const nonEmpty = lines.map((l) => l.trim()).filter(Boolean);
  const warnings: string[] = [];

  const ingStart = lines.findIndex((l) => INGREDIENTS_RE.test(l.trim()));
  const methodStart = lines.findIndex((l, i) => i > ingStart && METHOD_RE.test(l.trim()));

  // Title: first line, unless the text starts straight with ingredients or with "Serves 4".
  const first = nonEmpty[0] ?? "";
  const title =
    first && !QTY_START_RE.test(first) && !INGREDIENTS_RE.test(first) && !SERVINGS_LINE_RE.test(first) ? cleanSpaces(first) : "";
  if (!title) warnings.push("Titre manquant.");

  let servings: number | null = null;
  for (const l of nonEmpty.slice(0, 40)) {
    if (SERVINGS_LINE_RE.test(l)) {
      servings = parseServings(l);
      if (servings) break;
    }
  }

  // Ingredient block: between the headers, or (no headers) the run of lines before the first numbered step.
  let from: number;
  let to: number;
  if (ingStart >= 0) {
    from = ingStart + 1;
    to = methodStart >= 0 ? methodStart : lines.length;
  } else {
    // No header: the ingredients are the first run of lines after the title/servings, up to a blank line or a numbered step.
    from = title ? lines.findIndex((l) => l.trim() === first) + 1 : 0;
    while (from < lines.length && (!lines[from].trim() || SERVINGS_LINE_RE.test(lines[from].trim()))) from++;
    to = from;
    while (to < lines.length && lines[to].trim() && !STEP_RE.test(lines[to]) && !METHOD_RE.test(lines[to].trim())) to++;
    warnings.push("En-tête « Ingrédients » absent : liste devinée.");
  }

  const ingredients: ParsedIngredient[] = [];
  let section: string | null = null;
  for (let i = from; i < to; i++) {
    const line = lines[i].trim();
    if (!line || SERVINGS_LINE_RE.test(line)) continue;
    const prevBlank = i > from && !lines[i - 1].trim();
    const next = lines.slice(i + 1, to).find((l) => l.trim())?.trim();
    if (isTextSectionHeader(line, prevBlank, next)) {
      section = line.replace(/:\s*$/, "").replace(/^(for the|pour (le|la|les|l['’]))\s*/i, "").trim();
      continue;
    }
    const p = parseIngredientLine(line, section);
    if (p.name) ingredients.push(p);
  }

  // Steps: after the method header (or after the ingredients when there is none), until "Notes".
  const instructions: string[] = [];
  const notes: string[] = [];
  let inNotes = false;
  for (let i = methodStart >= 0 ? methodStart + 1 : to; i < lines.length; i++) {
    const line = cleanSpaces(lines[i]);
    if (!line) continue;
    if (NOTES_RE.test(line)) {
      inNotes = true;
      continue;
    }
    if (METHOD_RE.test(line)) continue;
    (inNotes ? notes : instructions).push(line.replace(STEP_RE, ""));
  }

  return {
    title,
    sourceUrl: null,
    servings,
    totalMinutes: null,
    image: null,
    ingredients,
    instructions,
    method: ingredients.length ? "text" : "none",
    warnings: notes.length ? [...warnings, `Notes : ${notes.join(" ")}`] : warnings,
  };
}
