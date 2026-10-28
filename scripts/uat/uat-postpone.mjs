// Live check of "Reporter à la semaine suivante" and the two weekly lists, in a throw-away household (never the book).
// Run from scripts/uat (Playwright installed as for uat-e2e.mjs): node uat-postpone.mjs
import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const SITE = "https://momo-et-jeje-cuisinent-vege.vercel.app";
const EDGE = "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
// The book's recipes and their catalogue articles, read like any visitor (public key, in src/lib/supabase.ts).
const conf = readFileSync(new URL("../../src/lib/supabase.ts", import.meta.url), "utf8");
const SB = conf.match(/https:\/\/\w+\.supabase\.co/)[0];
const KEY = conf.match(/"(sb_publishable_[^"]+|eyJ[^"]+)"/)[1];
const rest = async (path) => (await fetch(`${SB}/rest/v1/${path}`, { headers: { apikey: KEY, Authorization: `Bearer ${KEY}` } })).json();
const book = await rest("recipes?select=title,recipe_ingredients(ingredients(name,pantry))&limit=500");
const byTitle = new Map(book.map((r) => [r.title.trim(), r]));
// Lemon / lime lines may become juice, water is never bought: left out of the comparisons.
const articles = (title) => {
  const r = byTitle.get(title);
  if (!r) throw new Error(`recette introuvable dans le livre : ${title}`);
  return new Set(r.recipe_ingredients.map((i) => i.ingredients).filter((c) => c && !c.pantry && !/^(Citron|Lime|Jus de|Eau)/.test(c.name)).map((c) => c.name));
};
console.log(`${book.length} recettes lues dans le livre`);

let failed = 0;
const check = (cond, msg) => {
  console.log(`${cond ? "OK  " : "KO  "} ${msg}`);
  if (!cond) failed++;
};

const browser = await chromium.launch({ executablePath: EDGE, headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "fr-CA" });
const page = await ctx.newPage();
page.on("dialog", (d) => d.accept());
page.setDefaultTimeout(25000);

const titles = async () => (await page.locator("article.card h3").allInnerTexts()).map((s) => s.trim());
const waitIdle = () => page.waitForFunction(() => ![...document.querySelectorAll("button")].some((b) => b.textContent?.includes("Faire la liste") && b.disabled));
const cardOf = (title) => page.locator("article.card").filter({ has: page.locator("h3", { hasText: title }) });
async function makeList() {
  await waitIdle();
  await page.getByRole("button", { name: /Faire la liste/ }).click();
  await page.waitForURL(/\/liste/);
  await page.getByText(/articles? à acheter/).waitFor();
  const labels = await page.locator("ul.card li span.font-medium").allInnerTexts();
  const header = await page.locator("header p").first().innerText();
  return { labels: new Set(labels.map((l) => l.replace(/ \(facultatif\)$/, "").trim())), header };
}
async function week(which) {
  await page.goto(SITE + "/semaine");
  await page.getByRole("heading", { name: /Semaine du/ }).waitFor();
  if (which === "next") await page.getByRole("button", { name: "Semaine suivante", exact: true }).click();
  await page.getByText(/Chargement de la semaine/).waitFor({ state: "detached" }).catch(() => {});
  await page.waitForTimeout(800);
}

try {
  // A new household (anonymous access).
  await page.goto(SITE);
  await page.waitForURL(/\/foyer/);
  await page.getByPlaceholder("Notre foyer").fill(`TEST uat-report-${Date.now().toString(36)}`);
  await page.getByRole("button", { name: "Créer", exact: true }).click();
  await page.waitForURL(/\/semaine/);

  // This week: suggest, make the list (the shopping is done).
  await week("this");
  await page.getByRole("button", { name: /Proposer une semaine de/ }).click();
  await page.locator("article.card h3").first().waitFor();
  await waitIdle();
  const thisWeek = await titles();
  const own = (t) => [...articles(t)].filter((a) => !thisWeek.some((o) => o !== t && articles(o).has(a)));
  const x = [...thisWeek].sort((p, q) => own(q).length - own(p).length)[0];
  const others = thisWeek.filter((t) => t !== x);
  const onlyX = own(x);
  if (!onlyX.length) throw new Error("aucune recette de la semaine n'a d'article à elle seule : relancer");
  console.log(`Cette semaine : ${thisWeek.join(" | ")}\nRecette reportée : ${x} ; articles qui ne viennent que d'elle : ${onlyX.join(", ") || "(aucun)"}`);
  const before = await makeList();
  check(onlyX.every((a) => before.labels.has(a)), `liste de cette semaine avant report : contient les articles de « ${x} »`);

  // Postpone X, ingredients already bought.
  await week("this");
  await cardOf(x).getByRole("button", { name: "Reporter à la semaine suivante" }).click();
  await page.getByText("Ses ingrédients sont-ils déjà achetés ?").waitFor();
  await page.getByRole("button", { name: /Oui : ne pas les remettre/ }).click();
  await page.waitForFunction((t) => ![...document.querySelectorAll("article.card h3")].some((h) => h.textContent?.trim() === t), x);
  await waitIdle();
  const after = await titles();
  check(!after.includes(x) && others.every((o) => after.includes(o)), "cette semaine : la recette est partie, les autres restent");
  const portionsText = await page.getByText(/prévues? pour/).innerText();
  console.log(`     ${portionsText}`);

  // This week's list made again: X's own articles are gone.
  const thisList = await makeList();
  check(onlyX.every((a) => !thisList.labels.has(a)), "liste de cette semaine refaite : plus les articles de la recette reportée");
  check(/Semaine du/.test(thisList.header), `en-tête de la liste : « ${thisList.header} »`);

  // Next week: X is there, marked as bought.
  await week("next");
  check((await titles()).includes(x), "semaine suivante : la recette reportée y est");
  check(await cardOf(x).getByText("Reportée · ingrédients déjà achetés").isVisible(), "carte : « Reportée · ingrédients déjà achetés »");

  // Suggest the rest of next week: X stays.
  await page.getByRole("button", { name: /Proposer une autre semaine/ }).click();
  await page.waitForTimeout(1500);
  await waitIdle();
  const next = await titles();
  check(next.includes(x), `« Proposer une autre semaine » garde la recette reportée (${next.length} recettes)`);
  const nextOthers = next.filter((t) => t !== x);
  const onlyXNext = [...articles(x)].filter((a) => !nextOthers.some((o) => articles(o).has(a)));
  const nextList = await makeList();
  check(onlyXNext.every((a) => !nextList.labels.has(a)), `liste de la semaine suivante : sans les articles de « ${x} » (${onlyXNext.join(", ") || "aucun à vérifier"})`);

  // Change of mind: put its ingredients back on the list.
  await week("next");
  await cardOf(x).getByRole("button", { name: "Mettre ses ingrédients sur la liste" }).click();
  await cardOf(x).getByText("Reportée · sur la liste").waitFor();
  const nextList2 = await makeList();
  check(onlyXNext.every((a) => nextList2.labels.has(a)), "après « Mettre ses ingrédients sur la liste » : ils sont sur la liste suivante");

  // The list page switches between the two weeks.
  await page.goto(SITE + "/liste");
  await page.getByText(/articles? à acheter/).waitFor();
  await page.getByRole("button", { name: "Cette semaine", exact: true }).click();
  await page.getByText(/articles? à acheter/).waitFor();
  const a = new Set(await page.locator("ul.card li span.font-medium").allInnerTexts());
  await page.getByRole("button", { name: "Semaine suivante", exact: true }).click();
  await page.waitForTimeout(1500);
  const b = new Set(await page.locator("ul.card li span.font-medium").allInnerTexts());
  check(a.size > 0 && b.size > 0 && [...a].join() !== [...b].join(), `Épicerie : deux listes différentes (${a.size} et ${b.size} articles)`);

  // Second path: postpone with "Non" -> on next week's list.
  await week("this");
  const y = (await titles())[0];
  await cardOf(y).getByRole("button", { name: "Reporter à la semaine suivante" }).click();
  await page.getByRole("button", { name: /Non : les mettre sur la liste/ }).click();
  await page.waitForFunction((t) => ![...document.querySelectorAll("article.card h3")].some((h) => h.textContent?.trim() === t), y);
  await waitIdle();
  await week("next");
  check(await cardOf(y).getByText("Reportée · sur la liste").isVisible(), `« Non » : « ${y} » reportée, sur la liste`);
  const yArticles = [...articles(y)];
  const nextList3 = await makeList();
  check(yArticles.every((a) => nextList3.labels.has(a)), "« Non » : ses ingrédients sont sur la liste suivante");
} catch (e) {
  failed++;
  console.log("KO   arrêt :", (e?.message ?? String(e)).split("\n")[0]);
  await page.screenshot({ path: "screenshots/postpone.png", fullPage: true }).catch(() => {});
} finally {
  // Leave the test household.
  try {
    await page.goto(SITE + "/reglages");
    await page.getByRole("button", { name: "Quitter ce foyer" }).click();
    await page.waitForURL(/\/foyer/);
  } catch {}
  await browser.close();
}
console.log(failed ? `${failed} vérification(s) en échec` : "TOUT FONCTIONNE");
process.exit(failed ? 1 : 0);
