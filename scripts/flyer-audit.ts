// Show how the current Maxi flyer matches the catalogue. Usage: npx tsx scripts/flyer-audit.ts [postal code]
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchMaxiFlyer } from "../src/lib/flyerSource";
import { toDeals } from "../src/lib/flyer";
import { nameKey } from "../src/lib/text";

const catalog = JSON.parse(readFileSync(join(__dirname, "..", "data", "catalog.json"), "utf8")).ingredients as { name: string; aliases: string[] }[];
const aliases = new Map<string, string>();
for (const i of catalog) for (const a of i.aliases) aliases.set(nameKey(a), i.name);

fetchMaxiFlyer(process.argv[2] ?? "H4C0B8", new Date()).then((f) => {
  if (!f) return console.log("Aucune circulaire Maxi trouvée.");
  const deals = toDeals(f.items, aliases, "Maxi");
  console.log(`Circulaire ${f.validFrom} → ${f.validTo} : ${f.items.length} articles, ${deals.length} associations`);
  for (const d of deals) console.log(`  ${d.ingredient.padEnd(34)} <- ${d.item.slice(0, 90)}  ${d.price ?? ""}`);
});
