// End-to-end check of "Nouvelle recette" on the live site, the way the page does it: read (link, then pasted text),
// match to the catalogue, create a household ingredient for an unmatched line, save, learn the alias, read back.
// Uses a throw-away household, deleted at the end.
// Usage: npx tsx scripts/add-recipe-test.ts [site=https://grocery-eight-beta.vercel.app]
import { createClient } from "@supabase/supabase-js";
import { buildAliasIndex, matchIngredient } from "../src/lib/catalog";
import type { ImportedRecipe } from "../src/lib/importRecipe";
import { SUPABASE_KEY, SUPABASE_URL } from "../src/lib/supabase";
import { nameKey } from "../src/lib/text";

const SITE = process.argv[2] ?? "https://grocery-eight-beta.vercel.app";
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
const must = <T>(r: { data: T; error: unknown }) => {
  if (r.error) throw new Error(JSON.stringify(r.error));
  return r.data;
};

const TEXT = `Salade tiède de pois chiches au zaatar
Portions : 4

Ingrédients
1 boîte (540 ml) de pois chiches, rincés
2 tasses de chou frisé haché
1 c. à soupe de zaatar
2 c. à soupe d'huile d'olive
Le jus d'un citron
1 pincée de sel
3 c. à soupe de graines de courge

Préparation
1. Rôtir les pois chiches avec l'huile et le zaatar 20 minutes à 200 °C.
2. Mélanger avec le chou, le jus de citron et le sel.
3. Garnir de graines de courge.`;

async function aliasIndex() {
  const rows: { ingredient_id: string; alias: string; household_id: string | null }[] = [];
  for (let from = 0; ; from += 1000) {
    const data = must(await sb.from("ingredient_aliases").select("ingredient_id,alias,household_id").order("id").range(from, from + 999));
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  rows.sort((a, b) => Number(a.household_id !== null) - Number(b.household_id !== null));
  return buildAliasIndex(rows.map((r) => ({ id: r.ingredient_id, aliases: [r.alias] })));
}

async function main() {
  const session = must(await sb.auth.signInAnonymously()).session!;
  const householdId = must(await sb.rpc("create_household", { p_name: "TEST Claude recette (à supprimer)", p_display_name: "test" })) as string;
  let failures = 0;
  try {
    const catalog = must(await sb.from("ingredients").select("id,name").order("name")) as { id: string; name: string }[];
    const nameOf = new Map(catalog.map((c) => [c.id, c.name]));
    for (const [mode, body] of [
      ["url", { url: "https://margauxfood.ca/recette/nouilles-udon-au-tofu-croustillant/" }],
      ["text", { text: TEXT }],
    ] as const) {
      try {
        console.log(`\n=== ${mode === "url" ? "Lien web" : "Texte collé"} ===`);
        const res = await fetch(`${SITE}/api/import`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
          body: JSON.stringify(body),
        });
        const draft = (await res.json()) as ImportedRecipe & { error?: string };
        if (!res.ok) throw new Error(draft.error ?? `HTTP ${res.status}`);
        console.log(`Titre : ${draft.title} | portions ${draft.servings} | ${draft.ingredients.length} ingrédients | ${draft.instructions.length} étapes | image ${draft.image ? "oui" : "non"}`);
        const index = await aliasIndex();
        const links = draft.ingredients.map((i) => matchIngredient(i.name, index));
        draft.ingredients.forEach((i, n) => console.log(`  ${links[n] ? "✓" : "✗"} ${i.raw}  ->  ${links[n] ? nameOf.get(links[n]!) : "(à associer)"}`));

        // Unmatched lines: the page makes the user create or pick an ingredient; here each gets a household ingredient.
        for (let n = 0; n < links.length; n++) {
          if (links[n]) continue;
          const created = must(await sb.from("ingredients").insert({ household_id: householdId, name: `TEST ${draft.ingredients[n].name}`, aisle: "autre" }).select("id,name").single()) as { id: string; name: string };
          links[n] = created.id;
          nameOf.set(created.id, created.name);
          console.log(`  + nouvel ingrédient du foyer : ${created.name}`);
        }

        const recipe = must(await sb.from("recipes").insert({
          household_id: householdId,
          title: draft.title || "Recette sans titre",
          source_type: mode === "url" ? "url" : "manual",
          source_url: mode === "url" ? (body as { url: string }).url : null,
          image_url: draft.image,
          servings: draft.servings,
          total_minutes: draft.totalMinutes,
          instructions: draft.instructions,
          dish_type: null,
          protein: null,
          seasons: ["printemps", "ete", "automne", "hiver"],
        }).select("id").single()) as { id: string };
        must(await sb.from("recipe_ingredients").insert(draft.ingredients.map((i, position) => ({
          recipe_id: recipe.id, position, section: i.section, raw: i.raw, quantity: i.quantity, quantity_max: i.quantityMax,
          unit: i.unit, name: i.name, note: i.note, optional: i.optional, ingredient_id: links[position],
        }))));
        const learned = draft.ingredients
          .map((i, n) => ({ alias: nameKey(i.name), ingredient_id: links[n] }))
          .filter((a, n) => a.ingredient_id && a.alias && matchIngredient(draft.ingredients[n].name, index) !== a.ingredient_id);
        for (const a of learned) must(await sb.from("ingredient_aliases").insert({ ...a, household_id: householdId }));

        const back = must(await sb.from("recipe_ingredients").select("id,ingredient_id").eq("recipe_id", recipe.id)) as { ingredient_id: string | null }[];
        if (back.length !== draft.ingredients.length || back.some((b) => !b.ingredient_id)) throw new Error("relecture incomplète");
        const again = await aliasIndex();
        const relearned = learned.filter((a) => matchIngredient(draft.ingredients.filter((_, k) => links[k] === a.ingredient_id)[0]?.name ?? "", again) === a.ingredient_id).length;
        console.log(`OK : recette enregistrée et relue (${back.length} lignes), ${learned.length} alias appris, ${relearned} reconnus ensuite`);
      } catch (e) {
        failures++;
        console.log(`ÉCHEC : ${e instanceof Error ? e.message : e}`);
      }
    }
  } finally {
    must(await sb.from("recipes").delete().eq("household_id", householdId));
    must(await sb.from("ingredient_aliases").delete().eq("household_id", householdId));
    must(await sb.from("ingredients").delete().eq("household_id", householdId));
    must(await sb.from("household_members").delete().eq("household_id", householdId));
    console.log("\nFoyer de test nettoyé.");
  }
  console.log(failures ? `${failures} ÉCHEC(S)` : "AJOUT DE RECETTE : TOUT FONCTIONNE");
  process.exit(failures ? 1 : 0);
}

main();
