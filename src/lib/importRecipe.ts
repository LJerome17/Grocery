// Import a recipe from a web page without AI:
// 1. schema.org Recipe data embedded in the page (most blogs), else
// 2. a heuristic reader that finds the "Ingredients" / "Method" sections in the HTML.

import * as cheerio from "cheerio";
import type { AnyNode } from "domhandler";
import { parseIngredientBlock, parseIngredientLine, type ParsedIngredient, type SourceLine } from "./parseIngredient";
import { cleanSpaces, decodeEntities } from "./text";

export type ImportedRecipe = {
  title: string;
  sourceUrl: string | null;
  servings: number | null;
  totalMinutes: number | null;
  image: string | null;
  ingredients: ParsedIngredient[];
  instructions: string[];
  method: "jsonld" | "html" | "text" | "none";
  warnings: string[];
};

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

export async function fetchRecipe(url: string): Promise<ImportedRecipe> {
  const res = await fetch(url, {
    headers: { "User-Agent": USER_AGENT, "Accept-Language": "fr-CA,fr;q=0.9,en;q=0.8" },
    redirect: "follow",
  });
  if (!res.ok) throw new Error(`Le site a refusé la lecture (HTTP ${res.status}). Utilisez plutôt « coller le texte ».`);
  return extractRecipe(await res.text(), url);
}

export function extractRecipe(html: string, url: string | null = null): ImportedRecipe {
  const $ = cheerio.load(html);
  const fromLd = extractJsonLd($);
  const site = siteIngredients($);
  if (fromLd && site.length) return { ...fromLd, ingredients: site, sourceUrl: url };
  if (fromLd && fromLd.ingredients.length) return { ...fromLd, sourceUrl: url };
  const fromHtml = extractHeuristic($);
  if (fromLd) {
    // Recipe data without ingredients: keep its metadata, take the lists from the HTML.
    return {
      ...fromHtml,
      title: fromLd.title || fromHtml.title,
      servings: fromLd.servings ?? fromHtml.servings,
      totalMinutes: fromLd.totalMinutes ?? fromHtml.totalMinutes,
      image: fromLd.image ?? fromHtml.image,
      sourceUrl: url,
    };
  }
  return { ...fromHtml, sourceUrl: url };
}

// ---------- site adapters ----------

/**
 * Sites whose schema.org data drops the units ("2 ail" instead of "2 gousses d'ail").
 * Mordu (Radio-Canada) shows the full name and the quantity in separate elements.
 */
function siteIngredients($: cheerio.CheerioAPI): ParsedIngredient[] {
  const out: ParsedIngredient[] = [];
  $(".ingredients-list-group").each((_, group) => {
    const section = cleanSpaces($(group).find('[class*="ingredients-list-group__title"]').first().text()) || null;
    $(group)
      .find(".ingredients-list-group__list__item")
      .each((__, item) => {
        const title = cleanSpaces($(item).find('[class*="__item__title"]').first().text());
        let qty = cleanSpaces($(item).find('[class*="__item__quantity"]').first().text());
        if (!title) return;
        // Quantity field sometimes carries the preparation: "1, le zeste râpé finement".
        let prep = "";
        const split = qty.match(/^([\d½¼¾⅓⅔⅛/.\s]+),\s*(.+)$/);
        if (split) [qty, prep] = [split[1].trim(), split[2]];
        const line = /^[\d½¼¾⅓⅔⅛]/.test(qty) ? `${qty} ${title}${prep ? `, ${prep}` : ""}` : `${title} ${qty}`;
        out.push(parseIngredientLine(line, section));
      });
  });
  return out;
}

// ---------- schema.org JSON-LD ----------

type Json = unknown;

function findRecipeNode(node: Json): Record<string, Json> | null {
  if (!node || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const n of node) {
      const r = findRecipeNode(n);
      if (r) return r;
    }
    return null;
  }
  const obj = node as Record<string, Json>;
  const type = obj["@type"];
  const types = Array.isArray(type) ? type : [type];
  if (types.includes("Recipe")) return obj;
  return findRecipeNode(obj["@graph"]) ?? findRecipeNode(obj["mainEntity"]);
}

function extractJsonLd($: cheerio.CheerioAPI): ImportedRecipe | null {
  let recipe: Record<string, Json> | null = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (recipe) return;
    try {
      recipe = findRecipeNode(JSON.parse($(el).text()));
    } catch {
      /* malformed block, ignore */
    }
  });
  if (!recipe) return null;
  const r = recipe as Record<string, Json>;

  const ingredients = asStringArray(r.recipeIngredient ?? r.ingredients).map((l) => parseIngredientLine(l));
  return {
    title: cleanSpaces(decodeEntities(String(r.name ?? "")).replace(/<[^>]+>/g, " ")),
    sourceUrl: null,
    servings: parseServings(asStringArray(r.recipeYield).join(" ")),
    totalMinutes: parseIsoDuration(r.totalTime) ?? sumDurations(r.prepTime, r.cookTime),
    image: imageUrl(r.image),
    ingredients,
    instructions: flattenInstructions(r.recipeInstructions),
    method: "jsonld",
    warnings: [],
  };
}

function asStringArray(v: Json): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.flatMap(asStringArray);
  if (typeof v === "string" || typeof v === "number") return [String(v)];
  return [];
}

function flattenInstructions(v: Json): string[] {
  if (v == null) return [];
  if (typeof v === "string") {
    const html = cheerio.load(v);
    const items = html("li, p").map((_, el) => cleanSpaces(html(el).text())).get().filter(Boolean);
    return items.length ? items : v.split(/\n+/).map((s) => cleanSpaces(decodeEntities(s))).filter(Boolean);
  }
  if (Array.isArray(v)) return v.flatMap(flattenInstructions);
  if (typeof v === "object") {
    const o = v as Record<string, Json>;
    if (o.itemListElement) return flattenInstructions(o.itemListElement);
    if (o.text) return [cleanSpaces(decodeEntities(String(o.text)))];
    if (o.name) return [cleanSpaces(decodeEntities(String(o.name)))];
  }
  return [];
}

function imageUrl(v: Json): string | null {
  if (!v) return null;
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return imageUrl(v[0]);
  if (typeof v === "object") return imageUrl((v as Record<string, Json>).url);
  return null;
}

export function parseIsoDuration(v: Json): number | null {
  if (typeof v !== "string") return null;
  const m = v.match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?/i);
  if (!m || !(m[1] || m[2] || m[3])) return null;
  return Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
}

function sumDurations(...vs: Json[]): number | null {
  const mins = vs.map(parseIsoDuration).filter((n): n is number => n !== null);
  return mins.length ? mins.reduce((a, b) => a + b, 0) : null;
}

/** "Serves: 6-8" -> 6 (lower bound, so planned leftovers are never short). */
export function parseServings(text: string): number | null {
  const t = text.replace(/\s+/g, " ");
  const m =
    t.match(/(?:serves|servings|yield|makes|portions?|rendement|donne)\s*:?\s*(\d+)/i) ??
    t.match(/(\d+)\s*(?:-|–|à|to)?\s*\d*\s*(?:servings|portions|personnes|people|parts)/i) ??
    t.match(/^\s*(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

function parseMinutesText(text: string): number | null {
  const m = text.match(/(?:cooks? in|total time|temps total|cook time|temps de cuisson|ready in|prêt en)\s*:?\s*(?:(\d+)\s*(?:h|hr|hrs|hours?|heures?)\s*)?(?:(\d+)\s*(?:min|mins|minutes))?/i);
  if (!m || !(m[1] || m[2])) return null;
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

// ---------- heuristic HTML reader ----------

type Line = SourceLine & { heading: boolean };

const BLOCK_TAGS = new Set([
  "p", "div", "li", "ul", "ol", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "td", "section", "article",
  "table", "blockquote", "figure", "header", "footer", "aside", "main", "dd", "dt", "label",
]);
const BOLD_TAGS = new Set(["b", "strong"]);
const HEADING_RE = /^h[1-6]$/;

/** Flatten the page into visual lines, remembering which ones are entirely bold or headings. */
function pageLines($: cheerio.CheerioAPI): Line[] {
  $("script, style, noscript, svg, nav, form, iframe, button, select").remove();
  const lines: Line[] = [];
  let buf = "";
  let boldChars = 0;
  let plainChars = 0;
  let headingChars = 0;

  const flush = () => {
    const text = cleanSpaces(decodeEntities(buf));
    if (text) {
      lines.push({ text, bold: boldChars > 0 && plainChars === 0, heading: headingChars > 0 && headingChars >= boldChars + plainChars });
    }
    buf = "";
    boldChars = plainChars = headingChars = 0;
  };

  const walk = (node: AnyNode, bold: boolean, heading: boolean) => {
    if (node.type === "text") {
      const t = (node as unknown as { data: string }).data;
      buf += t;
      const n = t.replace(/\s/g, "").length;
      if (heading) headingChars += n;
      else if (bold) boldChars += n;
      else plainChars += n;
      return;
    }
    if (node.type !== "tag") return;
    const el = node as unknown as { name: string; children: AnyNode[] };
    const name = el.name.toLowerCase();
    if (name === "br") return flush();
    const block = BLOCK_TAGS.has(name);
    if (block) flush();
    for (const c of el.children) walk(c, bold || BOLD_TAGS.has(name), heading || HEADING_RE.test(name));
    if (block) flush();
  };

  const body = $("body").get(0);
  if (body) walk(body as AnyNode, false, false);
  flush();
  return lines;
}

const INGREDIENTS_RE = /^ingr[ée]dients?\s*:?$/i;
const METHOD_RE = /^(method|instructions?|directions?|preparation|préparation|étapes|etapes|steps|how to make( it)?|mode de préparation)\s*:?$/i;
const STOP_RE = /^(notes?|nutrition|tips|astuces?|conseils?|video|vidéo|comments?|commentaires?|related|you may also like|print)\b/i;

function extractHeuristic($: cheerio.CheerioAPI): ImportedRecipe {
  const title =
    cleanSpaces($("h1").first().text()) ||
    cleanSpaces($('meta[property="og:title"]').attr("content") ?? "") ||
    cleanSpaces($("title").first().text()).replace(/\s+[-|–]\s+[^-|–]+$/, "");
  const image = $('meta[property="og:image"]').attr("content") ?? null;
  const lines = pageLines($);
  const fullText = lines.map((l) => l.text).join("\n");
  const warnings: string[] = [];

  // First "Ingredients" line that is followed shortly by a line starting with a quantity.
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!INGREDIENTS_RE.test(lines[i].text)) continue;
    if (lines.slice(i + 1, i + 5).some((l) => /^[\d½¼¾⅓⅔]/.test(l.text))) {
      start = i;
      break;
    }
  }

  let ingredients: ParsedIngredient[] = [];
  const instructions: string[] = [];
  if (start < 0) {
    warnings.push("Section « Ingrédients » introuvable : collez la liste d'ingrédients manuellement.");
  } else {
    let end = start + 1;
    while (end < lines.length && !METHOD_RE.test(lines[end].text) && end - start < 80) end++;
    ingredients = parseIngredientBlock(lines.slice(start + 1, end).filter((l) => l.text.length < 160));

    if (end < lines.length && METHOD_RE.test(lines[end].text)) {
      for (let i = end + 1; i < lines.length && instructions.length < 40; i++) {
        const l = lines[i];
        if (STOP_RE.test(l.text) || (l.heading && !/^(step|étape)/i.test(l.text))) break;
        if (l.text.length >= 25) instructions.push(l.text); // skips "Watch video", "Print", etc.
      }
    }
    if (!instructions.length) warnings.push("Étapes de préparation introuvables.");
  }

  return {
    title,
    sourceUrl: null,
    servings: parseServings(fullText),
    totalMinutes: parseMinutesText(fullText),
    image,
    ingredients,
    instructions,
    method: ingredients.length ? "html" : "none",
    warnings,
  };
}
