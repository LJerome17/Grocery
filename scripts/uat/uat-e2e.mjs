// Automated run of the acceptance checklist (UAT) against the live site, in throw-away households (never the recipe book).
// Needs Playwright once: npm i --no-save playwright ; uses the Edge already installed (fresh temporary profile).
// Run from scripts/uat: node uat-e2e.mjs  -> uat-results.json + screenshots/ of failures.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";

const SITE = "https://momo-et-jeje-cuisinent-vege.vercel.app";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const starter = JSON.parse(readFileSync(new URL("../../public/starter/recipes.json", import.meta.url), "utf8"));
const byTitle = new Map(starter.map((r) => [r.title, r]));
mkdirSync("screenshots", { recursive: true });

const results = [];
const note = (id, statut, text) => { results.push({ id, statut, note: text }); console.log(`${statut.padEnd(6)} ${id}  ${text}`); };
async function test(id, page, fn) {
  try { const t = await fn(); note(id, "ok", t ?? ""); }
  catch (e) { note(id, "ko", (e?.message ?? String(e)).split("\n")[0].slice(0, 300)); try { await page.screenshot({ path: `screenshots/${id}.png`, fullPage: true }); } catch {} }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const n = Date.now().toString(36);
const USER = `test-uat-${n}`, PASS = "motdepasse-uat";

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, locale: "fr-CA" };
async function newPhone() {
  const ctx = await browser.newContext(phone);
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  page.setDefaultTimeout(20000);
  return { ctx, page };
}
const text = (page) => page.locator("body").innerText();
const nav = (page, name) => page.getByRole("link", { name, exact: false }).last().click();

// ---------- A: access ----------
const A = await newPhone();
let pa = A.page;
await test("A1", pa, async () => {
  await pa.goto(SITE);
  await pa.waitForURL(/\/foyer/);
  await pa.getByPlaceholder("Nom d'utilisateur").fill(USER);
  await pa.getByPlaceholder("Mot de passe (6 caractères minimum)").fill(PASS);
  await pa.getByRole("button", { name: "Créer", exact: true }).click();
  await pa.waitForURL(/\/semaine/);
  for (const t of ["Semaine", "Épicerie", "Recettes", "Réglages"]) expect(await pa.getByRole("link", { name: t }).count(), `onglet ${t} absent`);
  return "foyer d'essai créé (avec nom d'utilisateur), page Semaine et 4 onglets";
});
let invite = "";
await test("A3", pa, async () => {
  await nav(pa, "Réglages");
  await pa.waitForURL(/\/reglages/);
  const t = await text(pa);
  expect(t.includes(`Connecté : ${USER}`), "« Connecté : " + USER + " » absent");
  invite = (await pa.locator("p.font-mono").first().innerText()).trim();
  expect(/^[0-9a-f]{8}$/.test(invite), "code d'invitation illisible: " + invite);
  return `« Connecté : ${USER} »`;
});
await test("B2", pa, async () => {
  const t = await text(pa);
  const dish = t.match(/Même type de plat[\s\S]*?−\s*(\d+)\s*\+/), prot = t.match(/Même protéine[\s\S]*?−\s*(\d+)\s*\+/);
  expect(dish?.[1] === "2" && prot?.[1] === "3", `valeurs ${dish?.[1]} / ${prot?.[1]}`);
  await pa.getByRole("button", { name: "Augmenter : Même type de plat" }).click();
  await pa.waitForFunction(() => /Même type de plat[\s\S]*?−\s*3\s*\+/.test(document.body.innerText));
  await pa.getByRole("button", { name: "Diminuer : Même type de plat" }).click();
  await pa.waitForFunction(() => /Même type de plat[\s\S]*?−\s*2\s*\+/.test(document.body.innerText));
  return "2 et 3 par défaut ; − et + changent la valeur";
});
await test("B3", pa, async () => {
  await pa.getByRole("button", { name: "English", exact: true }).click();
  await pa.getByRole("link", { name: "Week" }).waitFor();
  const t = await text(pa);
  expect(t.includes("Settings") && t.includes("Groceries") && !t.includes("Réglages"), "interface pas en anglais");
  await pa.getByRole("button", { name: "Français", exact: true }).click();
  await pa.getByRole("link", { name: "Semaine" }).waitFor();
  return "passe en anglais (Week, Groceries, Settings) puis revient en français";
});

const B = await newPhone();
let pb = B.page;
await test("A5", pb, async () => {
  await pb.goto(SITE);
  await pb.waitForURL(/\/foyer/);
  await pb.getByPlaceholder("Code d'invitation (dans Réglages)").fill(invite);
  await pb.getByRole("button", { name: "Rejoindre" }).click();
  await pb.waitForURL(/\/semaine/);
  await nav(pb, "Réglages");
  await pb.getByText("2 membres").waitFor();
  return "le 2e téléphone rejoint avec le code ; Réglages affiche 2 membres";
});

const C = await newPhone();
await test("A4", C.page, async () => {
  const p = C.page;
  await p.goto(SITE + "/connexion");
  await p.getByPlaceholder("Nom d'utilisateur").fill(USER);
  await p.getByPlaceholder("Mot de passe (6 caractères minimum)").fill(PASS);
  await p.locator("form button:not([type=button])").click();
  await p.waitForURL(/\/semaine/);
  await nav(p, "Réglages");
  const code = (await p.locator("p.font-mono").first().innerText()).trim();
  expect(code === invite, "autre foyer: " + code);
  return "connexion par nom d'utilisateur dans un autre navigateur : même foyer";
});

// ---------- C: recipes ----------
await test("C1", pa, async () => {
  await nav(pa, "Recettes");
  await pa.waitForURL(/\/recettes$/);
  await pa.locator('a[href^="/recettes/"]:not([href="/recettes/nouvelle"])').first().waitFor();
  const count = await pa.locator('a[href^="/recettes/"]:not([href="/recettes/nouvelle"])').count();
  expect(count === 74, `${count} recettes`);
  return "74 recettes";
});
await test("C2", pa, async () => {
  const cards = pa.locator('a[href^="/recettes/"]:not([href="/recettes/nouvelle"])');
  await pa.getByPlaceholder("Chercher un titre ou un ingrédient…").fill("pois chiches");
  await pa.waitForTimeout(500);
  const found = await cards.count();
  expect(found > 0 && found < 74, `recherche: ${found}`);
  await pa.getByPlaceholder("Chercher un titre ou un ingrédient…").fill("");
  await pa.getByRole("button", { name: "Hiver", exact: true }).click();
  await pa.waitForTimeout(500);
  const winter = await cards.count();
  await pa.getByRole("button", { name: "Hiver", exact: true }).click();
  expect(winter > 0 && winter < 74, `filtre Hiver: ${winter}`);
  return `recherche « pois chiches » : ${found} recettes ; filtre Hiver : ${winter}`;
});
async function openRecipe(title) {
  await pa.goto(SITE + "/recettes");
  await pa.getByPlaceholder("Chercher un titre ou un ingrédient…").fill(title);
  await pa.locator('a[href^="/recettes/"]:not([href="/recettes/nouvelle"])').filter({ hasText: title }).first().click();
  await pa.getByText("Ingrédients", { exact: true }).waitFor();
  return text(pa);
}
await test("C3", pa, async () => {
  const t = await openRecipe("Marry Me Chickpeas");
  expect(t.includes("2 cans chickpeas (30 oz), drained and rinsed"), "ligne des pois chiches absente");
  expect(!/Pois chiches \(conserve\)/.test(t), "ligne traduite ?");
  return "affichée telle qu'écrite, « 2 cans chickpeas (30 oz), drained and rinsed »";
});
await test("C4", pa, async () => {
  const r = await openRecipe("Soupe ramen maison végé");
  for (const l of ["4 oeufs (garniture)", "Maïs (garniture)", "Coriandre (garniture)", "Graines de sésame (garniture)"]) expect(r.includes(l), "ramen: " + l);
  const s = await openRecipe("Bol de tofu shawarma au houmous");
  expect(s.includes("½ c. à thé de gingembre moulu") && s.includes("Poivre au goût"), "shawarma: gingembre moulu ou poivre");
  return "garnitures du ramen sur 4 lignes ; shawarma : gingembre moulu, sel et poivre séparés";
});
await test("C5", pa, async () => {
  await pa.goto(SITE + "/recettes");
  await pa.locator('a[href^="/recettes/"] img').first().waitFor();
  for (let y = 0; y < 30; y++) { await pa.mouse.wheel(0, 1200); await pa.waitForTimeout(150); }
  await pa.waitForTimeout(1500);
  const r = await pa.evaluate(() => [...document.querySelectorAll('a[href^="/recettes/"] img')].map((i) => ({ ok: i.complete && i.naturalWidth > 0, alt: i.alt })));
  const bad = r.filter((x) => !x.ok).map((x) => x.alt);
  expect(r.length >= 74 && !bad.length, `${r.length} images, sans photo: ${bad.join(", ")}`);
  return `${r.length} photos chargées`;
});

// ---------- D: week ----------
let target = 19;
const cardsTitles = async () => (await pa.locator("article.card h3").allInnerTexts()).map((s) => s.trim());
const planned = async () => {
  const m = (await text(pa)).match(/(\d+) portions? prévues? pour (\d+) demandées?/);
  return m ? { got: +m[1], want: +m[2] } : null;
};
const meta = (title) => byTitle.get(title);
await test("D1", pa, async () => {
  await nav(pa, "Semaine");
  await pa.waitForURL(/\/semaine/);
  const portions = pa.getByRole("spinbutton", { name: "Portions" });
  await portions.fill("19"); await portions.press("Enter");
  const max = pa.getByRole("spinbutton", { name: "Recettes (au plus)" });
  await max.fill("5"); await max.press("Enter");
  const propose = pa.getByRole("button", { name: /Proposer une semaine de/ });
  if (await propose.count()) await propose.click();
  await pa.locator("article.card h3").first().waitFor();
  await pa.waitForTimeout(1500);
  const p = await planned(), titles = await cardsTitles();
  expect(p && p.want === 19 && p.got >= 19, "portions: " + JSON.stringify(p));
  expect(titles.length >= 1 && titles.length <= 5, `${titles.length} recettes`);
  return `${p.got} portions prévues pour 19, ${titles.length} recettes (${titles.join(" / ")})`;
});
await test("D4", pa, async () => {
  const titles = await cardsTitles();
  const relaxed = (await text(pa)).includes("Variété assouplie");
  const count = (key) => { const c = {}; for (const t of titles) { const v = meta(t)?.[key]; if (v) c[v] = (c[v] ?? 0) + 1; } return c; };
  const dish = count("dish_type"), prot = count("protein");
  const ok = Object.values(dish).every((x) => x <= 2) && Object.values(prot).every((x) => x <= 3);
  expect(ok || relaxed, `types ${JSON.stringify(dish)} protéines ${JSON.stringify(prot)}`);
  return `types ${JSON.stringify(dish)}, protéines ${JSON.stringify(prot)}${relaxed ? " (variété assouplie affichée)" : ""}`;
});
async function openCategories() {
  if (!(await pa.getByText("Seules les recettes marquées", { exact: false }).count())) await pa.getByRole("button", { name: /Catégories proposées/ }).click();
}
async function onlySeason(want) {
  await openCategories();
  for (const s of ["Printemps", "Été", "Automne", "Hiver"]) {
    const b = pa.getByRole("button", { name: s, exact: true });
    const on = (await b.getAttribute("class"))?.includes("chip-on");
    if ((s === want) !== !!on) { await b.click(); await pa.waitForTimeout(1200); }
  }
}
await test("D2", pa, async () => {
  await onlySeason("Hiver");
  await pa.getByRole("button", { name: /Proposer une autre semaine/ }).click();
  await pa.waitForTimeout(2500);
  const titles = await cardsTitles();
  const bad = titles.filter((t) => meta(t) && !meta(t).seasons.includes("hiver"));
  expect(titles.length && !bad.length, "hors hiver: " + bad.join(", "));
  return `${titles.length} recettes, toutes marquées Hiver`;
});
await test("D3", pa, async () => {
  await openCategories();
  await pa.getByRole("button", { name: "ramen", exact: true }).click();
  await pa.waitForTimeout(1500);
  const seen = new Set();
  for (let k = 0; k < 4; k++) {
    await pa.getByRole("button", { name: /Proposer une autre semaine/ }).click();
    await pa.waitForTimeout(2000);
    (await cardsTitles()).forEach((t) => seen.add(t));
  }
  const ramen = [...seen].filter((t) => meta(t)?.dish_type === "ramen");
  expect(!ramen.length, "ramen proposé: " + ramen.join(", "));
  return `aucun ramen sur 4 semaines proposées (${seen.size} recettes vues)`;
});
await test("D5", pa, async () => {
  const seen = new Set(); let short = 0;
  const first = pa.locator("article.card").first();
  for (let k = 0; k < 10; k++) {
    const before = (await first.locator("h3").innerText()).trim();
    await first.getByRole("button", { name: /Échanger/ }).click();
    await pa.waitForFunction((b) => document.querySelector("article.card h3")?.textContent?.trim() !== b, before, { timeout: 15000 }).catch(() => {});
    seen.add((await first.locator("h3").innerText()).trim());
    const p = await planned(); if (!p || p.got < p.want) short++;
  }
  expect(seen.size >= 5 && short === 0, `${seen.size} recettes différentes, ${short} fois sous les portions`);
  return `${seen.size} recettes différentes en 10 échanges, portions toujours atteintes`;
});
await test("D6", pa, async () => {
  const card = pa.locator("article.card").first();
  await card.getByRole("button", { name: "Augmenter" }).click();
  await pa.waitForFunction(() => /× 2 =/.test(document.querySelector("article.card")?.innerText ?? ""));
  await card.locator("a").first().click();
  await pa.waitForURL(/fois=2/);
  await pa.goBack();
  await pa.locator("article.card").first().getByRole("button", { name: "Diminuer" }).click();
  return "carte « × 2 = », la recette s'ouvre avec ?fois=2";
});
await test("D7", pa, async () => {
  const now = await cardsTitles();
  await pa.getByRole("button", { name: "Suivante" }).click();
  await pa.waitForTimeout(2000);
  const propose = pa.getByRole("button", { name: /Proposer une semaine de/ });
  if (await propose.count()) await propose.click();
  await pa.waitForTimeout(2500);
  await pa.getByRole("button", { name: "Cette semaine" }).click();
  await pa.waitForTimeout(2500);
  const back = await cardsTitles();
  expect(JSON.stringify(back) === JSON.stringify(now), "semaine changée: " + back.join(" / "));
  return "la semaine suivante a son propre plan ; cette semaine est inchangée";
});

// Put known recipes in the week so the list checks have something to check.
const LIST_RECIPES = ["Marry Me Chickpeas", "Cari de patates douces, lentilles et halloumi", "Palak tofu", "Potage à la courge musquée", "Tofu Magique", "Tofu grillé aux olives et à l'aneth"];
await test("D8", pa, async () => {
  await onlySeason("");
  await openCategories();
  const r = pa.getByRole("button", { name: "ramen", exact: true });
  if ((await r.getAttribute("class"))?.includes("line-through")) await r.click();
  await pa.waitForTimeout(1500);
  const portions = pa.getByRole("spinbutton", { name: "Portions" });
  await portions.fill("40"); await portions.press("Enter");
  const max = pa.getByRole("spinbutton", { name: "Recettes (au plus)" });
  await max.fill("10"); await max.press("Enter");
  await pa.waitForTimeout(2000);
  // Empty the week, then pick our recipes one by one ("＋ Choisir une recette" on an empty week, "＋ Ajouter" after).
  while (await pa.locator("article.card").count()) { await pa.locator("article.card").first().getByRole("button", { name: "Retirer" }).click(); await pa.waitForTimeout(900); }
  const extra = new Set();
  for (const t of LIST_RECIPES) {
    const pick = pa.getByRole("button", { name: /Choisir une recette/ });
    if (await pick.count()) await pick.click(); else await pa.getByRole("button", { name: /Ajouter/ }).last().click();
    await pa.getByPlaceholder("Chercher une recette…").fill(t);
    await pa.locator("li button").filter({ hasText: t }).first().click();
    await pa.waitForTimeout(1200);
  }
  for (const t of extra) if (!LIST_RECIPES.includes(t)) {
    await pa.locator("article.card").filter({ has: pa.locator("h3", { hasText: t }) }).first().getByRole("button", { name: "Retirer" }).click();
    await pa.waitForTimeout(900);
  }
  const titles = await cardsTitles();
  expect(LIST_RECIPES.every((t) => titles.includes(t)) && titles.length === LIST_RECIPES.length, "recettes: " + titles.join(" / "));
  await pa.getByRole("button", { name: /Faire la liste/ }).click();
  await pa.waitForURL(/\/liste/);
  await pa.getByText("À vérifier au garde-manger").waitFor();
  return `6 recettes choisies avec « Ajouter », puis « Faire la liste » ouvre l'Épicerie`;
});

// ---------- E: grocery list ----------
async function openPantry(p = pa) {
  const b = p.getByRole("button", { name: /garde-manger|pantry/i });
  if ((await b.innerText()).startsWith("▸")) await b.click();
}
const listText = async () => { await openPantry(); return text(pa); };
const line = async (label) => {
  const row = pa.locator("li, div").filter({ has: pa.getByText(label, { exact: true }) }).last();
  return (await row.innerText()).replace(/\s+/g, " ").trim();
};
await test("E1", pa, async () => {
  const t = await listText();
  const missing = [];
  for (const title of LIST_RECIPES) for (const i of byTitle.get(title).ingredients)
    if (i.catalog && i.catalog !== "Eau" && !t.includes(i.catalog)) missing.push(`${title}: ${i.catalog}`);
  expect(!missing.length, "absents: " + missing.join(" ; "));
  return "chaque ingrédient des 6 recettes est sur la liste, sous son nom français";
});
await test("E2", pa, async () => {
  const l = await line("Pois chiches (conserve)");
  expect(/\d+ boîtes? \(540 ml\)/.test(l), l);
  return l;
});
await test("E3", pa, async () => {
  await openPantry();
  const rice = await line("Riz blanc"), spin = await line("Épinards"), broth = await line("Bouillon de légumes");
  expect(/paquets?/.test(spin), "épinards: " + spin);
  expect(/au besoin/.test(rice), "riz (« Riz cuit pour servir », sans quantité): " + rice);
  expect(/\d+ ?(ml|L)/.test(broth) && !/cube/.test(broth), "bouillon: " + broth);
  expect(/\d/.test(rice), "riz: " + rice);
  return `${rice} | ${spin} | ${broth}`;
});
await test("E4", pa, async () => {
  const t = await listText();
  const i = t.toLowerCase().indexOf("à vérifier au garde-manger");
  expect(i > 0, "section absente");
  const pantry = t.slice(i);
  for (const p of ["Sel", "Huile"]) expect(pantry.includes(p), p + " pas au garde-manger");
  return "section « À vérifier au garde-manger » en bas, avec sel, huiles, épices…";
});
await test("E5", pa, async () => {
  const t = await listText();
  const ranges = (t.match(/\d[\d ,½¼¾⅓⅔]* à \d/g) ?? []).length, opt = (t.match(/\(facultatif\)/g) ?? []).length;
  expect(!/NaN|undefined|Infinity|\b0 (boîte|g|ml)\b/.test(t), "valeur absurde sur la liste");
  return `${ranges} plage(s) « à », ${opt} article(s) facultatif(s), aucune valeur absurde`;
});
await test("E10", pa, async () => {
  const x = await line("Tofu extra-ferme"), side = await line("Légumes d'accompagnement (au choix)");
  const firm = (await listText()).split(/\r?\n/).some((l) => l.trim() === "Tofu ferme");
  expect(/bloc/.test(x) && !firm && /au besoin/.test(side), `${x} | ${side} | ferme présent: ${firm}`);
  return `${x} | ${side} (les 6 recettes n'utilisent que du tofu extra-ferme : pas de ligne « Tofu ferme »)`;
});
await test("E6", pa, async () => {
  await pb.goto(SITE + "/liste");
  await pb.getByText("À vérifier au garde-manger").waitFor();
  const before = await pb.getByRole("button", { name: "Décocher" }).count();
  const boxes = pa.getByRole("button", { name: "Cocher", exact: true });
  await boxes.nth(0).click(); await pa.waitForTimeout(400); await boxes.nth(0).click();
  const t0 = Date.now();
  await pb.waitForFunction((n) => document.querySelectorAll('button[aria-label="Décocher"]').length >= n + 2, before, { timeout: 15000 });
  return `2 articles cochés sur le téléphone A apparaissent cochés sur B en ${((Date.now() - t0) / 1000).toFixed(1)} s, sans recharger`;
});
await test("E7", pa, async () => {
  await pa.getByPlaceholder("Ajouter un article (papier de toilette…)").fill("Papier de toilette");
  await pa.getByRole("button", { name: "Ajouter" }).click();
  await pa.getByText("Papier de toilette", { exact: true }).waitFor();
  return "article ajouté à la main visible";
});
await test("E9", pa, async () => {
  const checked = await pa.getByRole("button", { name: "Décocher" }).count();
  await pa.getByRole("button", { name: "Masquer les cochés" }).click();
  await pa.waitForTimeout(500);
  const hidden = await pa.getByRole("button", { name: "Décocher" }).count();
  await pa.getByRole("button", { name: "Tout afficher" }).click();
  await pa.waitForTimeout(500);
  const shown = await pa.getByRole("button", { name: "Décocher" }).count();
  expect(checked >= 2 && hidden === 0 && shown === checked, `${checked} / ${hidden} / ${shown}`);
  return `${checked} cochés masqués puis réaffichés`;
});
await test("E8", pa, async () => {
  const checkedLabels = await pa.evaluate(() => [...document.querySelectorAll('button[aria-label="Décocher"]')].map((b) => b.closest("li,div")?.querySelector(".font-medium")?.textContent?.trim()).filter(Boolean));
  await nav(pa, "Semaine");
  await pa.locator("article.card").first().waitFor();
  const last = pa.locator("article.card").last();
  await last.getByRole("button", { name: /Échanger/ }).click();
  await pa.waitForTimeout(2500);
  await pa.getByRole("button", { name: /Faire la liste/ }).click();
  await pa.waitForURL(/\/liste/);
  await pa.getByText("À vérifier au garde-manger").waitFor();
  const t = await listText();
  const still = await pa.evaluate(() => [...document.querySelectorAll('button[aria-label="Décocher"]')].map((b) => b.closest("li,div")?.querySelector(".font-medium")?.textContent?.trim()));
  const lost = checkedLabels.filter((l) => t.includes(l) && !still.includes(l));
  expect(t.includes("Papier de toilette") && !lost.length, "perdus: " + lost.join(", ") + (t.includes("Papier de toilette") ? "" : " ; article manuel perdu"));
  return `après un échange et « Faire la liste » : ${checkedLabels.length} cochés gardés, article manuel gardé`;
});

// ---------- A6: offline ----------
await test("A6", pa, async () => {
  await pa.route("**/rest/v1/**", (r) => r.abort());
  await pa.goto(SITE + "/semaine");
  await pa.getByText("Connexion impossible").waitFor();
  const t = await text(pa);
  expect(!t.includes("Votre foyer"), "renvoyé vers la création de foyer");
  await pa.unroute("**/rest/v1/**");
  await pa.getByRole("button", { name: "Réessayer" }).click();
  await pa.getByRole("link", { name: "Réglages" }).waitFor();
  return "« Connexion impossible » + Réessayer, jamais la création de foyer ; tout revient après Réessayer";
});

// ---------- F: a friend's household, in English ----------
const F = await newPhone();
const pf = F.page;
await test("F1", pf, async () => {
  await pf.goto(SITE);
  await pf.waitForURL(/\/foyer/);
  await pf.getByRole("button", { name: "English", exact: true }).click();
  await pf.getByRole("button", { name: "Create", exact: true }).click();
  await pf.waitForURL(/\/semaine/);
  await pf.getByRole("link", { name: "Settings" }).click();
  await pf.getByText("Our household", { exact: true }).waitFor();
  return "foyer « Our household », interface en anglais";
});
await test("F2", pf, async () => {
  await pf.getByRole("link", { name: "Recipes" }).click();
  await pf.locator('a[href^="/recettes/"]').first().waitFor();
  const count = await pf.locator('a[href^="/recettes/"]:not([href="/recettes/nouvelle"])').count();
  const add = await pf.getByRole("link", { name: /Add/ }).count();
  await pf.locator('a[href^="/recettes/"]').first().click();
  await pf.getByText("Ingredients", { exact: true }).waitFor();
  const prefs = await pf.getByRole("button", { name: /Preferences/ }).count();
  const starEnabled = await pf.getByRole("button", { name: /^1 star/ }).isEnabled();
  expect(count === 74 && !add && !prefs && !starEnabled, `${count} recettes, Add ${add}, Preferences ${prefs}, étoiles actives ${starEnabled}`);
  await pf.goto(SITE + "/recettes/nouvelle");
  await pf.getByText(/only they can add/i).waitFor();
  return "74 recettes visibles ; ni Add, ni Preferences, étoiles figées ; la page d'ajout est refusée";
});
await test("F3", pf, async () => {
  await pf.getByRole("link", { name: "Week" }).click();
  await pf.waitForURL(/\/semaine/);
  await pf.getByRole("button", { name: /Suggest a week of/ }).click();
  await pf.locator("article.card h3").first().waitFor();
  await pf.getByRole("button", { name: /Make the list/ }).click();
  await pf.waitForURL(/\/liste/);
  await pf.getByText("Check the pantry").waitFor();
  const t = await text(pf);
  const french = ["Fruits et légumes", "au besoin", "boîte", "tasse", "(facultatif)", "Épices et herbes"].filter((w) => t.includes(w));
  expect(t.includes("Groceries") && !french.length, "français sur la liste: " + french.join(", "));
  return "liste en anglais (rayons, articles, unités), sans mot français";
});
await test("F5", pf, async () => {
  await pf.getByRole("link", { name: "Settings" }).click();
  await pf.getByRole("button", { name: "Leave this household" }).click();
  await pf.waitForURL(/\/foyer/);
  return "quitter ramène à la création de foyer";
});

// ---------- cleanup: leave the throw-away household on every phone ----------
for (const p of [pa, pb]) {
  try { await p.goto(SITE + "/reglages"); await p.getByRole("button", { name: "Quitter ce foyer" }).click(); await p.waitForURL(/\/foyer/); } catch {}
}
writeFileSync("uat-results.json", JSON.stringify(results, null, 1));
console.log(`\n${results.filter((r) => r.statut === "ok").length} réussis, ${results.filter((r) => r.statut === "ko").length} en échec`);
await browser.close();
