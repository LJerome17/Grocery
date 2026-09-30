// Compare a recipe page's structured data with its visible text (to find sites whose data is incomplete).
// Usage: npx tsx scripts/page-vs-data.ts <url> [...]
import * as cheerio from "cheerio";

async function main() {
  for (const url of process.argv.slice(2)) {
    const html = await (await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } })).text();
    const $ = cheerio.load(html);
    const ld = $('script[type="application/ld+json"]')
      .toArray()
      .map((e) => $(e).text())
      .find((t) => t.includes("recipeIngredient"));
    type Node = { recipeIngredient?: string[]; recipeInstructions?: unknown; "@graph"?: unknown };
    const find = (o: unknown): Node | null =>
      Array.isArray(o) ? o.map(find).find(Boolean) ?? null : o && typeof o === "object" ? ((o as Node).recipeIngredient ? (o as Node) : find((o as Node)["@graph"])) : null;
    const r = ld ? find(JSON.parse(ld)) : null;
    console.log(`== ${url}`);
    console.log(`  données structurées : ${r?.recipeIngredient?.length ?? 0} ingrédients`);
    for (const line of r?.recipeIngredient ?? []) console.log(`     · ${line}`);
    console.log(`  étapes structurées : ${JSON.stringify(r?.recipeInstructions ?? []).slice(0, 400)}…`);
    $("script, style, noscript, svg, nav, header, footer").remove();
    const text = $("main").length ? $("main").text() : $("body").text();
    const clean = text.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n");
    const i = clean.search(/Ingrédients/i);
    console.log(`  --- page visible ---\n${clean.slice(i, i + 3500)}`);
  }
}
main();
