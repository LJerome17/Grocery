// Bulk import of the recipe sources in recettes/ into data/recipes.raw.json:
//   recettes/Recettes Web.txt          links, one per line
//   recettes/Recettes en mode txt.txt  pasted recipes separated by 2+ blank lines
//   recettes/Recettes Photos/*.pdf     PDFs: imported from their web link when found, else from their text
//   data/photos/*.txt + manifest.json  transcriptions of the recipe photos (one-time, done with Claude)
// Usage: npx tsx scripts/import-local.ts
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractText, getDocumentProxy } from "unpdf";
import { fetchRecipe, type ImportedRecipe } from "../src/lib/importRecipe";
import { parseIngredientLine } from "../src/lib/parseIngredient";
import { parseRecipeText } from "../src/lib/parseRecipeText";
import { scaledQuantity } from "../src/lib/shopping";
import { nameKey } from "../src/lib/text";
import { cleanUrl } from "../src/lib/url";

const ROOT = join(__dirname, "..");
const SRC = join(ROOT, "recettes");
const PHOTOS = join(SRC, "Recettes Photos");
const TRANSCRIPTS = join(ROOT, "data", "photos");

export type Entry = ImportedRecipe & {
  slug: string;
  sourceType: "url" | "manual" | "photo" | "pdf";
  /** Local image to use as the recipe picture (photo recipes), relative to recettes/Recettes Photos. */
  localImage?: string | null;
  /** Original files the recipe came from (photos, PDF). */
  sourceFiles?: string[];
  error?: string;
};

type Fixes = {
  lines: Record<string, string | string[]>;
  titles: Record<string, string>;
  pdfUrls: Record<string, string>;
  urlRewrites: Record<string, string>;
  exclude?: { titles: string[] };
  manualForUrl?: Record<string, { file: string; totalMinutes?: number }>;
  photoToUrl?: Record<string, string>;
  servings?: Record<string, number | string>;
  scale?: Record<string, number | string>;
  addIngredients?: Record<string, string[] | string>;
};

/** Look up a per-title fix, ignoring accents, apostrophes and the "_doc" entry. */
function byTitle<T>(map: Record<string, T> | undefined, title: string): T | undefined {
  if (!map) return undefined;
  const key = nameKey(title);
  return Object.entries(map).find(([k]) => k !== "_doc" && nameKey(k) === key)?.[1];
}

type ManifestEntry = {
  recipeFile: string | null;
  title: string | null;
  images: string[];
  dishPhoto: string | null;
  photoFor: string | null;
  notes?: string;
};

const log = (r: ImportedRecipe, tag: string = r.method) =>
  console.log(`OK   ${tag.padEnd(6)} ${String(r.ingredients.length).padStart(3)} ingr  ${r.title || "(sans titre)"}`);

async function importUrl(url: string, extra: Partial<Entry> = {}): Promise<Omit<Entry, "slug">> {
  try {
    const r = await fetchRecipe(url);
    log(r);
    return { ...r, sourceType: "url", ...extra };
  } catch (e) {
    console.log(`FAIL ${url}  ${e}`);
    return { title: "", sourceUrl: url, servings: null, totalMinutes: null, image: null, ingredients: [], instructions: [], method: "none", warnings: [], sourceType: "url", error: String(e), ...extra };
  }
}

async function main() {
  const fixes = JSON.parse(readFileSync(join(ROOT, "data", "import-fixes.json"), "utf8")) as Fixes;
  const out: Omit<Entry, "slug">[] = [];

  // 1. Links
  const web = readFileSync(join(SRC, "Recettes Web.txt"), "utf8");
  // Print pages and other odd links are replaced by the recipe's normal page (see urlRewrites).
  const rewrite = (u: string) => Object.entries(fixes.urlRewrites ?? {}).find(([prefix]) => u.startsWith(prefix))?.[1] ?? u;
  const urls = [...new Set((web.match(/https?:\/\/\S+/g) ?? []).map((u) => rewrite(cleanUrl(u))))];
  for (const url of urls) {
    // Sites that block reading (Allrecipes): the recipe text was pasted by hand, the link is kept as the source.
    const manual = fixes.manualForUrl?.[url];
    if (manual) {
      const r = parseRecipeText(readFileSync(join(ROOT, manual.file), "utf8"));
      out.push({ ...r, sourceUrl: url, totalMinutes: manual.totalMinutes ?? r.totalMinutes, sourceType: "url" });
      log(r, "manuel");
    } else out.push(await importUrl(url));
  }

  // 2. Pasted text: recipes separated by 2+ blank lines; a block without ingredients (title only) is glued to the next one.
  const txt = readFileSync(join(SRC, "Recettes en mode txt.txt"), "utf8").replace(/\r/g, "").replace(/^.*\n/, "");
  const blocks = txt.split(/\n[ \t]*\n[ \t]*\n+/).map((b) => b.trim()).filter(Boolean);
  for (let i = 0; i < blocks.length; i++) {
    let r = parseRecipeText(blocks[i]);
    while (!r.ingredients.length && i + 1 < blocks.length) {
      blocks[i + 1] = `${blocks[i]}\n\n${blocks[i + 1]}`;
      r = parseRecipeText(blocks[++i]);
    }
    out.push({ ...r, sourceType: "manual" });
    log(r);
  }

  // 3. PDFs: prefer the web page (better data + picture), fall back to the PDF text.
  const pdfs = existsSync(PHOTOS) ? readdirSync(PHOTOS).filter((f) => f.toLowerCase().endsWith(".pdf")) : [];
  for (const file of pdfs) {
    const doc = await getDocumentProxy(new Uint8Array(readFileSync(join(PHOTOS, file))));
    const { text } = await extractText(doc, { mergePages: true });
    const found = text.match(/https?:\/\/[^\s]+/)?.[0];
    const known = Object.entries(fixes.pdfUrls ?? {}).find(([k]) => k.normalize("NFC") === file.normalize("NFC"))?.[1];
    const url = known ?? (found ? cleanUrl(found) : null);
    if (url && !urls.includes(url)) {
      out.push(await importUrl(url, { sourceFiles: [file] }));
    } else if (!url) {
      const r = parseRecipeText(text);
      out.push({ ...r, sourceType: "pdf", sourceFiles: [file] });
      log(r, "pdf");
    }
  }

  // 4. Photo transcriptions.
  const manifestPath = join(TRANSCRIPTS, "manifest.json");
  const manifest: ManifestEntry[] = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : [];
  for (const m of manifest) {
    if (!m.recipeFile) continue;
    // Screenshot cut off, but the full recipe is on the author's site: import the site instead.
    const official = byTitle(fixes.photoToUrl, m.title ?? "");
    if (typeof official === "string") {
      out.push(await importUrl(official, { sourceFiles: m.images }));
      continue;
    }
    const r = parseRecipeText(readFileSync(join(TRANSCRIPTS, m.recipeFile), "utf8"));
    out.push({ ...r, sourceType: "photo", localImage: m.dishPhoto ?? m.images[0] ?? null, sourceFiles: m.images });
    log(r, "photo");
  }

  // 5. Manual corrections (source typos, missing titles).
  let applied = 0;
  for (const r of out) {
    if (!r.title && r.ingredients[0] && fixes.titles[r.ingredients[0].raw]) {
      r.title = fixes.titles[r.ingredients[0].raw];
      r.warnings = r.warnings.filter((w) => w !== "Titre manquant.");
      applied++;
    }
    r.ingredients = r.ingredients.flatMap((i) => {
      const fix = fixes.lines[i.raw];
      if (fix === undefined) return [i];
      applied++;
      return (Array.isArray(fix) ? fix : [fix]).map((line) => parseIngredientLine(line, i.section));
    });
  }
  // Portions given by the user, whole-number scaling of recipes that are too small, extra ingredients.
  for (const r of out) {
    const servings = byTitle(fixes.servings, r.title);
    if (typeof servings === "number") r.servings = servings;
    const scale = byTitle(fixes.scale, r.title);
    if (typeof scale === "number" && scale > 1) {
      // The displayed line is rewritten too, so the recipe reads with the multiplied quantities.
      r.ingredients = r.ingredients.map((i) => {
        if (i.quantity === null) return i;
        // Weights in the notes ("environ 110 g") follow the multiplication too.
        const note = i.note?.replace(/(\d+(?:[.,]\d+)?)\s*(g|ml|kg|l)\b/gi, (_, n: string, u: string) => `${Math.round(Number(n.replace(",", ".")) * scale * 100) / 100} ${u}`) ?? null;
        const s = { ...i, note, quantity: i.quantity * scale, quantityMax: i.quantityMax === null ? null : i.quantityMax * scale };
        return { ...s, raw: `${scaledQuantity(s.quantity, s.quantityMax, s.unit, 1)} ${s.unit ? "de " : ""}${s.name}${s.note ? ` (${s.note})` : ""}` };
      });
      r.servings = (r.servings ?? 1) * scale;
    }
    const extra = byTitle(fixes.addIngredients, r.title);
    if (Array.isArray(extra)) r.ingredients.push(...extra.map((line) => parseIngredientLine(line, null)));
    if (servings !== undefined || scale !== undefined || extra !== undefined) applied++;
  }
  console.log(`${applied} corrections manuelles appliquées`);

  // 6. Dish photos that belong to recipes imported from text or the web (only real dish photos, not text pages).
  for (const m of manifest) {
    if (!m.photoFor || !m.dishPhoto) continue;
    const target = out.find((r) => nameKey(r.title) === nameKey(m.photoFor!));
    if (!target) console.log(`Photo sans recette correspondante : ${m.photoFor}`);
    else if (!target.localImage) {
      target.localImage = m.dishPhoto;
      target.sourceFiles = [...(target.sourceFiles ?? []), ...m.images];
    }
  }

  // 7. The user's own dish photos: recettes/Photo_recettes/<name of the recipe>.jpg wins over any other picture.
  const OWN = join(SRC, "Photo_recettes");
  if (existsSync(OWN)) {
    for (const file of readdirSync(OWN).filter((f) => /\.(jpe?g|png|webp|heic)$/i.test(f))) {
      const words = nameKey(file.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ")).split(" ").filter(Boolean);
      const matches = out.filter((r) => {
        const t = ` ${nameKey(r.title)} `;
        return words.every((w) => t.includes(` ${w} `));
      });
      if (matches.length === 1) {
        matches[0].localImage = `@own/${file}`;
        console.log(`Photo « ${file} » -> ${matches[0].title}`);
      } else console.log(`Photo « ${file} » : ${matches.length ? "plusieurs recettes possibles" : "aucune recette"} (renommez-la comme la recette)`);
    }
  }

  // Recipes removed at the user's request.
  const excluded = new Set((fixes.exclude?.titles ?? []).map(nameKey));
  const kept = out.filter((r) => !excluded.has(nameKey(r.title)));
  if (kept.length < out.length) console.log(`${out.length - kept.length} recette(s) exclue(s)`);

  // Stable ids for file names.
  const used = new Set<string>();
  const entries: Entry[] = kept.map((r) => {
    const base = nameKey(r.title || r.sourceUrl || "recette").replace(/ /g, "-").slice(0, 60) || "recette";
    let slug = base;
    for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
    used.add(slug);
    return { slug, ...r };
  });

  mkdirSync(join(ROOT, "data"), { recursive: true });
  writeFileSync(join(ROOT, "data", "recipes.raw.json"), JSON.stringify(entries, null, 2));
  console.log(`\n${entries.length} recettes -> data/recipes.raw.json`);
}

main();
