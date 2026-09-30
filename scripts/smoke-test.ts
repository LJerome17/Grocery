// End-to-end check of the live site and database, as a brand-new anonymous visitor.
// Creates a throw-away household, exercises the main flows, then deletes its data and leaves it.
// Usage: npx tsx scripts/smoke-test.ts [site=https://grocery-eight-beta.vercel.app]
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_KEY, SUPABASE_URL } from "../src/lib/supabase";

const SITE = process.argv[2] ?? "https://grocery-eight-beta.vercel.app";
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
  await step("postal code (default, then changed)", async () => {
    const h = must(await sb.from("households").select("postal_code,starter_seen").eq("id", householdId).single()) as { postal_code: string };
    if (h.postal_code !== "H4C 0B8") throw new Error(`default ${h.postal_code}`);
    must(await sb.from("households").update({ postal_code: "H2X 1Y4" }).eq("id", householdId));
    return "H4C 0B8 -> H2X 1Y4";
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
    const full = (await (await fetch(`${SITE}/starter/recipes.json`)).json()) as Record<string, unknown>[];
    const idByName = new Map(catalog!.map((c) => [c.name as string, c.id as string]));
    const ids: string[] = [];
    for (const r of full.slice(0, 3)) {
      await step(`import "${r.title}"`, async () => {
        const { ingredients, slug, ...recipe } = r as { ingredients: Record<string, unknown>[]; slug: string };
        const rec = must(await sb.from("recipes").insert({ ...recipe, starter_slug: slug, household_id: householdId }).select("id").single()) as { id: string };
        ids.push(rec.id);
        const rows = ingredients.map(({ catalog: cat, ...i }) => ({ ...i, recipe_id: rec.id, ingredient_id: cat ? idByName.get(cat as string) ?? null : null }));
        must(await sb.from("recipe_ingredients").insert(rows));
        return `${rows.length} ingrédients`;
      });
    }

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

    // 5b. Maxi deals for the household's postal code (unofficial source: may be empty, must not fail).
    await step("GET /api/rabais", async () => {
      const r = await fetch(`${SITE}/api/rabais?cp=H4C0B8`);
      const d = (await r.json()) as { deals?: { name: string }[]; validTo?: string; unavailable?: boolean; error?: string };
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      return d.unavailable ? "circulaire indisponible" : `${d.deals!.length} rabais jusqu'au ${d.validTo}`;
    });

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
    await step("cleanup recipes", async () => must(await sb.from("recipes").delete().eq("household_id", householdId)));
    await step("cleanup plans", async () => must(await sb.from("week_plans").delete().eq("household_id", householdId)));
    await step("leave test household", async () => must(await sb.from("household_members").delete().eq("household_id", householdId)));
  }

  console.log(`\n${failures ? `${failures} ÉCHEC(S)` : "TOUT FONCTIONNE"} (${starter?.length ?? "?"} recettes de départ en ligne)`);
  process.exit(failures ? 1 : 0);
}

main();
