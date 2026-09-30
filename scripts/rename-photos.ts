// Rename the recipe photos in recettes/Recettes Photos after their recipe title,
// and update every reference (data/photos/manifest.json, import-fixes imageCrops).
// The old -> new mapping is appended to data/photos/renames.json so it can be undone.
// Usage: npx tsx scripts/rename-photos.ts [--dry]
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { extname, join } from "node:path";

const ROOT = join(__dirname, "..");
const PHOTOS = join(ROOT, "recettes", "Recettes Photos");
const MANIFEST = join(ROOT, "data", "photos", "manifest.json");
const FIXES = join(ROOT, "data", "import-fixes.json");
const LOG = join(ROOT, "data", "photos", "renames.json");
const dry = process.argv.includes("--dry");

type ManifestEntry = { title: string | null; images: string[]; dishPhoto: string | null; photoFor: string | null };

const safe = (t: string) =>
  t.replace(/[\\/:*?"<>|]/g, " ").replace(/[«»]/g, "").replace(/\s+/g, " ").trim().slice(0, 90).replace(/[ .]+$/, "");

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as ManifestEntry[];
const mapping: Record<string, string> = {};
const taken = new Set<string>();

for (const m of manifest) {
  const title = m.title ?? m.photoFor;
  if (!title) continue;
  const base = safe(m.photoFor && !m.title ? `${m.photoFor} (page)` : title);
  m.images.forEach((old, i) => {
    let name = `${base}${m.images.length > 1 ? ` (${i + 1})` : ""}${extname(old).toLowerCase()}`;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${base} ${n}${extname(old).toLowerCase()}`;
    taken.add(name.toLowerCase());
    if (name !== old) mapping[old] = name;
  });
}

for (const [oldName, newName] of Object.entries(mapping)) {
  console.log(`${oldName}  ->  ${newName}`);
  if (dry) continue;
  if (!existsSync(join(PHOTOS, oldName))) throw new Error(`Introuvable : ${oldName}`);
  if (existsSync(join(PHOTOS, newName))) throw new Error(`Existe déjà : ${newName}`);
  renameSync(join(PHOTOS, oldName), join(PHOTOS, newName));
}

if (!dry) {
  const re = (f: string | null) => (f && mapping[f]) || f;
  for (const m of manifest) {
    m.images = m.images.map((f) => re(f)!);
    m.dishPhoto = re(m.dishPhoto);
  }
  writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

  const fixes = JSON.parse(readFileSync(FIXES, "utf8"));
  if (fixes.imageCrops) {
    fixes.imageCrops = Object.fromEntries(Object.entries(fixes.imageCrops).map(([k, v]) => [re(k), v]));
    writeFileSync(FIXES, JSON.stringify(fixes, null, 2) + "\n");
  }

  const log = existsSync(LOG) ? JSON.parse(readFileSync(LOG, "utf8")) : [];
  log.push({ date: new Date().toISOString(), renames: mapping });
  writeFileSync(LOG, JSON.stringify(log, null, 2) + "\n");
}
console.log(`\n${Object.keys(mapping).length} fichiers ${dry ? "à renommer" : "renommés"}`);
