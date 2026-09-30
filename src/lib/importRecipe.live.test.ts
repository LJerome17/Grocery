// Fetches real recipe pages. Run with: $env:LIVE=1; npx vitest run importRecipe.live
import { describe, it } from "vitest";
import { fetchRecipe } from "./importRecipe";
import { formatNumber, unitLabel } from "./units";

const URLS = [
  "https://www.gazoakleychef.com/recipes/lasagne/",
  "https://makeitdairyfree.com/one-pot-west-african-peanut-stew-vegan/",
  "https://www.mskcc.org/experience/patient-support/nutrition-cancer/recipes/quinoa-salad-feta",
];

describe.skipIf(!process.env.LIVE)("live import", () => {
  it.each(URLS)("%s", async (url) => {
    const r = await fetchRecipe(url);
    const lines = [
      `== ${r.title} [${r.method}] portions=${r.servings} minutes=${r.totalMinutes}`,
      ...r.ingredients.map(
        (i) =>
          `  ${i.section ? `[${i.section}] ` : ""}${i.quantity !== null ? formatNumber(i.quantity) : "-"}${i.quantityMax ? `-${i.quantityMax}` : ""} ${unitLabel(i.unit, i.quantity ?? 1)} | ${i.name}${i.note ? ` (${i.note})` : ""}${i.optional ? " *opt" : ""}`,
      ),
      `  étapes: ${r.instructions.length}; 1re: ${r.instructions[0]?.slice(0, 80) ?? "-"}`,
      ...r.warnings.map((w) => `  ! ${w}`),
    ];
    console.log(lines.join("\n"));
  }, 30000);
});
