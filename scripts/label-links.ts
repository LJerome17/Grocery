// Put the recipe name in front of each link in recettes/Recettes Web.txt: "- Titre : https://...".
// Titles come from data/recipes.raw.json (run import-local first). A backup of the file is kept in data/backup/.
// Usage: npx tsx scripts/label-links.ts
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanUrl } from "../src/lib/url";
import type { Entry } from "./import-local";

const ROOT = join(__dirname, "..");
const FILE = join(ROOT, "recettes", "Recettes Web.txt");
const recipes = JSON.parse(readFileSync(join(ROOT, "data", "recipes.raw.json"), "utf8")) as Entry[];
const fixes = JSON.parse(readFileSync(join(ROOT, "data", "import-fixes.json"), "utf8")) as { urlRewrites?: Record<string, string> };
const rewrite = (u: string) => Object.entries(fixes.urlRewrites ?? {}).find(([p]) => u.startsWith(p))?.[1] ?? u;

const FALLBACK: Record<string, string> = {
  "https://www.allrecipes.com/recipe/25311/vegetarian-moussaka/": "Moussaka végétarienne (site bloqué, à coller en texte)",
};

const raw = readFileSync(FILE, "utf8");
const bom = raw.startsWith("﻿") ? "﻿" : "";
let labelled = 0;
const lines = raw.replace(/^﻿/, "").split(/\r?\n/).map((line) => {
  const m = line.match(/^(\s*-?\s*)(https?:\/\/\S+)\s*$/); // only bare links; already labelled lines are left alone
  if (!m) return line;
  const url = rewrite(cleanUrl(m[2]));
  const title = recipes.find((r) => r.sourceUrl === url)?.title || FALLBACK[url];
  if (!title) return line;
  labelled++;
  return `- ${title} : ${m[2]}`;
});

mkdirSync(join(ROOT, "data", "backup"), { recursive: true });
// One backup per run, never overwritten.
copyFileSync(FILE, join(ROOT, "data", "backup", `Recettes Web.${new Date().toISOString().replace(/[:.]/g, "-")}.txt`));
writeFileSync(FILE, bom + lines.join(raw.includes("\r\n") ? "\r\n" : "\n"));
console.log(`${labelled} liens nommés`);
