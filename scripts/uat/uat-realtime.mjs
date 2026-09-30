// Reliability of live ticking between two phones: 10 rounds each way, in a throw-away household. Run: node uat-realtime.mjs
import { chromium } from "playwright";
const SITE = "https://momo-et-jeje-cuisinent-vege.vercel.app";
const browser = await chromium.launch({ executablePath: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", headless: true });
const phone = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "fr-CA" };
const mk = async () => { const c = await browser.newContext(phone); const p = await c.newPage(); p.on("dialog", (d) => d.accept()); p.setDefaultTimeout(20000); return p; };
const a = await mk(), b = await mk();
await a.goto(SITE); await a.waitForURL(/foyer/); await a.getByRole("button", { name: "Créer", exact: true }).click(); await a.waitForURL(/semaine/);
await a.getByRole("link", { name: "Réglages" }).click(); const code = (await a.locator("p.font-mono").first().innerText()).trim();
await b.goto(SITE); await b.waitForURL(/foyer/); await b.getByPlaceholder("Code d'invitation (dans Réglages)").fill(code); await b.getByRole("button", { name: "Rejoindre" }).click(); await b.waitForURL(/semaine/);
await a.getByRole("link", { name: "Semaine" }).click(); await a.getByRole("button", { name: /Proposer une semaine de/ }).click(); await a.locator("article.card").first().waitFor();
await a.getByRole("button", { name: /Faire la liste/ }).click(); await a.waitForURL(/liste/); await a.getByRole("button", { name: "Cocher" }).first().waitFor();
await b.goto(SITE + "/liste"); await b.getByRole("button", { name: /Cocher|Décocher/ }).first().waitFor();
const times = [];
for (let k = 0; k < 10; k++) {
  const before = await b.locator('button[aria-label="Décocher"]').count();
  const t0 = Date.now();
  await a.getByRole("button", { name: "Cocher", exact: true }).first().click();
  try { await b.waitForFunction((n) => document.querySelectorAll('button[aria-label="Décocher"]').length > n, before, { timeout: 15000 }); times.push(((Date.now() - t0) / 1000).toFixed(1)); }
  catch { times.push("RATÉ"); }
  // Every other round, B ticks and A must see it.
  const ba = await a.locator('button[aria-label="Décocher"]').count();
  const t1 = Date.now();
  await b.getByRole("button", { name: "Cocher", exact: true }).first().click();
  try { await a.waitForFunction((n) => document.querySelectorAll('button[aria-label="Décocher"]').length > n, ba, { timeout: 15000 }); times.push("B→A " + ((Date.now() - t1) / 1000).toFixed(1)); }
  catch { times.push("B→A RATÉ"); }
}
console.log(times.join(" | "));
for (const p of [a, b]) { try { await p.goto(SITE + "/reglages"); await p.getByRole("button", { name: "Quitter ce foyer" }).click(); } catch {} }
await browser.close();
