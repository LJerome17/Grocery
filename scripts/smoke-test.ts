// End-to-end check of the live site and database, as a brand-new anonymous visitor.
// Creates a throw-away household, exercises the main flows, then deletes its data and leaves it.
// Usage: npx tsx scripts/smoke-test.ts [site=https://momo-et-jeje-cuisinent-vege.vercel.app]
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_KEY, SUPABASE_URL } from "../src/lib/supabase";

const SITE = process.argv[2] ?? "https://momo-et-jeje-cuisinent-vege.vercel.app";
const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { persistSession: false } });
let failures = 0;

async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
  try {
    const out = await fn();
    console.log(`OK    ${name}${out !== undefined && typeof out !== "object" ? ` (${out})` : ""}`);
    return out;
  } catch (e) {
    failures++;
    console.log(`FAIL  ${name}: ${e instanceof Error ? e.message : JSON.stringify(e)}`);
    return undefined;
  }
}
const must = <T>(r: { data: T; error: unknown }) => {
  if (r.error) throw r.error;
  return r.data;
};

async function main() {
  // 1. Pages and static files served by Vercel.
  for (const path of ["/", "/connexion", "/foyer", "/semaine", "/liste", "/recettes", "/recettes/nouvelle", "/reglages", "/manifest.webmanifest", "/icon-192.png"]) {
    await step(`GET ${path}`, async () => {
      const r = await fetch(SITE + path);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.status;
    });
  }
  const starter = await step("starter recipes.json", async () => {
    const d = (await (await fetch(`${SITE}/starter/recipes.json`)).json()) as { title: string; image_url: string | null }[];
    const img = d.find((r) => r.image_url)!.image_url!;
    const ir = await fetch(SITE + img);
    if (!ir.ok) throw new Error(`image HTTP ${ir.status}`);
    return d;
  });
  await step("GET /semaine is the app (title)", async () => {
    const html = await (await fetch(`${SITE}/semaine`)).text();
    if (!html.includes("Momo et Jéjé")) throw new Error("new title not found");
    return "Momo et Jéjé";
  });

  // 2. Anonymous visitor.
  const session = await step("anonymous sign-in", async () => must(await sb.auth.signInAnonymously()).session!);
  if (!session) return;
  const token = session.access_token;

  // 3. Household.
  const householdId = await step("create household", async () => must(await sb.rpc("create_household", { p_name: "TEST Claude (à supprimer)", p_display_name: "test" })) as string);
  if (!householdId) return;
  await step("new household is not the book", async () => {
    const h = must(await sb.from("households").select("is_book").eq("id", householdId).single()) as { is_book: boolean };
    if (h.is_book !== false) throw new Error(`is_book = ${h.is_book}`);
    return "ok";
  });

  try {
    // 4. Catalogue + two starter recipes, the way the app imports them.
    const catalog = await step("read catalogue", async () => must(await sb.from("ingredients").select("id,name,aisle,pantry,count_unit,equiv").is("household_id", null)));
    await step("catalogue size", async () => catalog!.length);
    await step("catalogue names in French, default units", async () => {
      const names = new Set(catalog!.map((c) => c.name as string));
      for (const bad of ["Kale", "Chips de maïs", "Sauce BBQ", "Doubanjiang"]) if (names.has(bad)) throw new Error(`still "${bad}"`);
      for (const good of ["Chou frisé (kale)", "Croustilles de maïs", "Légumes d'accompagnement (au choix)", "Tomates entières (conserve)"])
        if (!names.has(good)) throw new Error(`missing "${good}"`);
      if (catalog!.find((c) => c.name === "Gingembre")?.count_unit !== "inch") throw new Error("Gingembre count_unit");
      if (!names.has("Gochujang") || !catalog!.find((c) => c.name === "Ail")?.equiv) throw new Error("0006 not applied");
      return "ok";
    });
    // Recipes: the Momo et Jéjé book is read live; only the book household may change it.
    const book = await step("read the recipe book", async () => {
      const r = must(await sb.from("recipes").select("id,title,household_id").order("title")) as { id: string; household_id: string }[];
      if (r.length < 60) throw new Error(`${r.length} recettes seulement`);
      if (r.some((x) => x.household_id !== r[0].household_id)) throw new Error("recipes from more than one household");
      return `${r.length} recettes`;
    });
    const ids = ((book && (must(await sb.from("recipes").select("id").order("title").limit(3)) as { id: string }[])) || []).map((r) => r.id);
    await step("book recipe ingredients readable", async () => {
      const n = (must(await sb.from("recipe_ingredients").select("id").in("recipe_id", ids)) as unknown[]).length;
      if (!n) throw new Error("none");
      return `${n} lignes`;
    });
    await step("adding a recipe is refused", async () => {
      const r = await sb.from("recipes").insert({ household_id: householdId, title: "TEST", source_type: "manual", instructions: [], seasons: [] });
      if (!r.error) throw new Error("insert accepted");
      return "refusé";
    });
    await step("changing a book recipe is refused", async () => {
      const r = await sb.from("recipes").update({ title: "TEST" }).eq("id", ids[0]).select("id");
      if (r.error) return "refusé";
      if ((r.data ?? []).length) throw new Error("update accepted");
      return "refusé";
    });

    // 5. Week plan + list.
    const plan = await step("save week plan", async () =>
      must(
        await sb
          .from("week_plans")
          .upsert(
            { household_id: householdId, week_start: "2026-09-28", suppers: 3, portions: 12, seasons: ["automne"], exclude_dish_types: ["ramen"] },
            { onConflict: "household_id,week_start" },
          )
          .select("id")
          .single(),
      ) as { id: string },
    );
    if (plan) {
      await step("add recipes to week", async () => {
        must(await sb.from("week_plan_recipes").insert(ids.map((recipe_id, position) => ({ plan_id: plan.id, recipe_id, position, multiplier: position === 0 ? 2 : 1, portions: 4 }))));
        return ids.length;
      });
      await step("shopping item insert + check + realtime publication", async () => {
        const item = must(await sb.from("shopping_items").insert({ plan_id: plan.id, label: "Test", aisle: "autre", manual: true }).select("id").single()) as { id: string };
        must(await sb.from("shopping_items").update({ checked: true }).eq("id", item.id));
        return "ok";
      });
    }

    // 6. Server import route with the visitor's token.
    await step("POST /api/import (lien)", async () => {
      const r = await fetch(`${SITE}/api/import`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ url: "https://margauxfood.ca/recette/nouilles-udon-au-tofu-croustillant/" }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      return `${d.ingredients.length} ingrédients, ${d.instructions.length} étapes`;
    });
    await step("POST /api/import refuses without token", async () => {
      const r = await fetch(`${SITE}/api/import`, { method: "POST", body: "{}" });
      if (r.status !== 401) throw new Error(`HTTP ${r.status}`);
      return 401;
    });

    // 7. Storage upload into the household folder.
    await step("photo upload", async () => {
      const png = await (await fetch(`${SITE}/icon-192.png`)).arrayBuffer();
      const path = `${householdId}/smoke-test.png`;
      must(await sb.storage.from("recipe-images").upload(path, png, { contentType: "image/png", upsert: false }));
      must(await sb.storage.from("recipe-images").remove([path]));
      return "ok";
    });
  } finally {
    // 8. Clean up: recipes (cascade to ingredients), plans (cascade to items), then leave.
    await step("cleanup plans", async () => must(await sb.from("week_plans").delete().eq("household_id", householdId)));
    await step("leave test household", async () => must(await sb.from("household_members").delete().eq("household_id", householdId)));
  }

  console.log(`\n${failures ? `${failures} ÉCHEC(S)` : "TOUT FONCTIONNE"} (${starter?.length ?? "?"} recettes de départ en ligne)`);
  process.exit(failures ? 1 : 0);
}

main();
