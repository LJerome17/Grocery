// One picture per recipe: download the web picture or take the local dish photo,
// resize to 720 px wide WebP (~30-100 KB) into data/images/<slug>.webp.
// Usage: npx tsx scripts/fetch-images.ts [--force]
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import sharp from "sharp";
import type { Entry } from "./import-local";

const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "data", "images");
const PHOTOS = join(ROOT, "recettes", "Recettes Photos");
const force = process.argv.includes("--force");

const UA = { "User-Agent": "Mozilla/5.0" };

async function download(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(url, { headers: UA });
    if (!res.ok || !(res.headers.get("content-type") ?? "").startsWith("image/")) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** When the announced picture is broken, try the other pictures of the page (skipping logos and small images). */
async function pagePicture(pageUrl: string): Promise<Buffer | null> {
  const html = await (await fetch(pageUrl, { headers: UA })).text();
  // The page's own sharing picture first (og:image), then any large picture of the page.
  const og = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];
  if (og) {
    const buf = await download(og.replace(/&amp;/g, "&"));
    if (buf) return buf;
  }
  const urls = [...new Set(html.match(/https?:\/\/[^"'\s)]+\.(?:jpe?g|png|webp)[^"'\s)]*/gi) ?? [])].filter(
    (u) => !/logo|icon|avatar|sprite|favicon/i.test(u),
  );
  for (const u of urls) {
    const buf = await download(u);
    if (!buf) continue;
    const { width = 0, height = 0 } = await sharp(buf).metadata();
    if (width >= 500 && height > 0 && width / height > 0.5 && width / height < 2.2) return buf;
  }
  return null;
}

/**
 * Recipe screenshots: keep only the dish photo. Text is grey on a flat background, so the photo is the
 * largest block of colourful pixels (per-pixel chroma = max(r,g,b) - min(r,g,b)).
 * Returns null when no convincing photo region is found.
 */
export async function cropToPhoto(buf: Buffer): Promise<Buffer | null> {
  const upright = await sharp(buf).rotate().toBuffer();
  const { width: W = 0, height: H = 0 } = await sharp(upright).metadata();
  const w = 120;
  const { data, info } = await sharp(upright).resize({ width: w }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const h = info.height;
  const colourful = (x: number, y: number) => {
    const i = (y * w + x) * 3;
    return Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 40;
  };

  // Best run of consecutive "busy" indices (small gaps allowed), scored by total activity.
  const bestRun = (scores: number[], min = 0.08, maxGap = 2): [number, number] | null => {
    let best: [number, number, number] | null = null;
    let start = -1, gap = 0, sum = 0;
    for (let i = 0; i <= scores.length; i++) {
      const on = i < scores.length && scores[i] > min;
      if (on) {
        if (start < 0) {
          start = i;
          sum = 0;
        }
        sum += scores[i];
        gap = 0;
      } else if (start >= 0 && (++gap > maxGap || i === scores.length)) {
        const end = i - gap;
        if (!best || sum > best[2]) best = [start, end, sum];
        start = -1;
        gap = 0;
      }
    }
    return best ? [best[0], best[1]] : null;
  };

  const rows = Array.from({ length: h }, (_, y) => {
    let n = 0;
    for (let x = 0; x < w; x++) n += colourful(x, y) ? 1 : 0;
    return n / w;
  });
  const ry = bestRun(rows);
  if (!ry) return null;
  const cols = Array.from({ length: w }, (_, x) => {
    let n = 0;
    for (let y = ry[0]; y <= ry[1]; y++) n += colourful(x, y) ? 1 : 0;
    return n / (ry[1] - ry[0] + 1);
  });
  const rx = bestRun(cols);
  if (!rx) return null;

  const s = W / w;
  const left = Math.floor(rx[0] * s), top = Math.floor(ry[0] * s);
  const width = Math.min(W - left, Math.ceil((rx[1] - rx[0] + 1) * s));
  const height = Math.min(H - top, Math.ceil((ry[1] - ry[0] + 1) * s));
  if (width < W * 0.25 || height < W * 0.2 || width / height > 3 || height / width > 3) return null;
  return sharp(upright).extract({ left, top, width, height }).toBuffer();
}

const DISH_COLOURS: Record<string, string> = {
  ramen: "#c2410c", soupe: "#b45309", mijoté: "#9a3412", salade: "#15803d", bol: "#0f766e", nouilles: "#b91c1c",
  pâtes: "#a16207", riz: "#854d0e", plaque: "#4d7c0f", four: "#7c2d12", wrap: "#0e7490", grillades: "#9f1239",
};

/** Placeholder card (title on a colour per dish type) until a real photo is added in the app. */
function placeholder(title: string, dishType: string | undefined): Buffer {
  const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const words = title.split(/\s+/);
  const lines: string[] = [];
  for (const word of words) {
    const last = lines.at(-1);
    if (last && (last + " " + word).length <= 22) lines[lines.length - 1] = last + " " + word;
    else lines.push(word);
  }
  const shown = lines.slice(0, 4);
  const y0 = 240 - (shown.length - 1) * 32;
  const text = shown.map((l, i) => `<text x="360" y="${y0 + i * 64}" text-anchor="middle">${esc(l)}</text>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="720" height="480">
    <rect width="720" height="480" fill="${DISH_COLOURS[dishType ?? ""] ?? "#475569"}"/>
    <g font-family="Segoe UI, Arial, sans-serif" font-size="50" font-weight="700" fill="#fff">${text}</g></svg>`;
  return Buffer.from(svg);
}

const manualCrops = (JSON.parse(readFileSync(join(ROOT, "data", "import-fixes.json"), "utf8")).imageCrops ?? {}) as Record<
  string,
  [number, number, number, number]
>;

// Official photos found online for recipes that came from screenshots or pasted text (data/image-search-results.json).
const officialImages = new Map<string, string>(
  (existsSync(join(ROOT, "data", "image-search-results.json"))
    ? (JSON.parse(readFileSync(join(ROOT, "data", "image-search-results.json"), "utf8")) as { slug: string; status: string; imageUrl: string | null }[])
    : []
  )
    .filter((x) => x.status === "found" && x.imageUrl)
    .map((x) => [x.slug, x.imageUrl!]),
);

async function source(r: Entry): Promise<Buffer | null> {
  if (r.localImage?.startsWith("@own/")) return readFileSync(join(ROOT, "recettes", "Photo_recettes", r.localImage.slice(5)));
  const official = officialImages.get(r.slug);
  if (official) {
    const buf = await download(official);
    if (buf) return buf;
  }
  // The user's own dish photo: used whole (no screenshot cropping).
  if (r.localImage?.startsWith("@own/")) return readFileSync(join(ROOT, "recettes", "Photo_recettes", r.localImage.slice(5)));
  if (r.localImage) {
    const file = readFileSync(join(PHOTOS, r.localImage));
    const crop = manualCrops[r.localImage];
    if (crop) {
      const [left, top, width, height] = crop;
      return sharp(file).rotate().extract({ left, top, width, height }).toBuffer();
    }
    return cropToPhoto(file);
  }
  const direct = r.image ? await download(r.image) : null;
  if (direct) return direct;
  return r.sourceUrl ? pagePicture(r.sourceUrl) : null;
}

async function main() {
  const recipes = (JSON.parse(readFileSync(join(ROOT, "data", "recipes.raw.json"), "utf8")) as Entry[]).filter((r) => !r.error);
  const meta = JSON.parse(readFileSync(join(ROOT, "data", "recipe-meta.json"), "utf8")).recipes as Record<string, { dish_type: string }>;
  mkdirSync(OUT, { recursive: true });
  const missing: string[] = [];
  let total = 0;
  for (const r of recipes) {
    const dest = join(OUT, `${r.slug}.webp`);
    if (existsSync(dest) && !force) continue;
    try {
      let buf = await source(r);
      if (!buf) {
        missing.push(r.title);
        buf = placeholder(r.title, meta[r.title]?.dish_type);
      }
      const info = await sharp(buf).rotate().resize({ width: 720, withoutEnlargement: true }).webp({ quality: 62 }).toFile(dest);
      total += info.size;
      console.log(`OK   ${String(Math.round(info.size / 1024)).padStart(4)} Ko  ${r.title}`);
    } catch (e) {
      missing.push(`${r.title} (${e})`);
    }
  }
  console.log(`\n${Math.round(total / 1024)} Ko écrits dans data/images/`);
  if (missing.length) console.log(`Vignette provisoire (pas de photo trouvée) :\n  ${missing.join("\n  ")}`);
}

main();
