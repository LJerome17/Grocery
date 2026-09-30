"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useApp } from "@/components/AppProvider";
import { RecipeImage } from "@/components/RecipeImage";
import { DISH_TYPES } from "@/lib/db";
import { SEASON_LABEL, seasonOf, type Season } from "@/lib/planner";
import { nameKey } from "@/lib/text";
import { useKitchen } from "@/lib/useKitchen";

export default function Recettes() {
  const { household, householdId } = useApp();
  const { recipes, ingredients, loading } = useKitchen(householdId);
  const [search, setSearch] = useState("");
  const [dish, setDish] = useState<string | null>(null);
  const [season, setSeason] = useState<Season | null>(null);

  // Search in titles and ingredient names ("coco" finds the curries).
  const ingredientText = useMemo(() => {
    const m = new Map<string, string>();
    for (const i of ingredients) m.set(i.recipe_id, `${m.get(i.recipe_id) ?? ""} ${nameKey(i.name)}`);
    return m;
  }, [ingredients]);

  const q = nameKey(search);
  const shown = recipes.filter(
    (r) =>
      (!q || nameKey(r.title).includes(q) || (ingredientText.get(r.id) ?? "").includes(q)) &&
      (!dish || r.dish_type === dish) &&
      (!season || r.seasons.includes(season)),
  );
  const dishTypes = DISH_TYPES.filter((d) => recipes.some((r) => r.dish_type === d));
  const now = seasonOf(new Date());

  if (loading) return <p className="py-20 text-center text-muted">Chargement…</p>;

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Recettes</h1>
        {household?.is_book && (
          <Link href="/recettes/nouvelle" className="btn-primary">
            ＋ Ajouter
          </Link>
        )}
      </header>

      <input className="input" placeholder="Chercher un titre ou un ingrédient…" value={search} onChange={(e) => setSearch(e.target.value)} />

      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1">
        {(Object.keys(SEASON_LABEL) as Season[]).map((s) => (
          <button key={s} className={season === s ? "chip-on" : "chip"} onClick={() => setSeason(season === s ? null : s)}>
            {SEASON_LABEL[s]}
            {s === now ? " •" : ""}
          </button>
        ))}
        <span className="w-2 shrink-0" />
        {dishTypes.map((d) => (
          <button key={d} className={`${dish === d ? "chip-on" : "chip"} shrink-0`} onClick={() => setDish(dish === d ? null : d)}>
            {d}
          </button>
        ))}
      </div>

      <p className="text-sm text-muted">
        {shown.length} recette{shown.length > 1 ? "s" : ""}
      </p>

      <ul className="grid grid-cols-2 gap-3">
        {shown.map((r) => (
          <li key={r.id}>
            <Link href={`/recettes/${r.id}`} className={`card block overflow-hidden ${r.active ? "" : "opacity-50"}`}>
              <RecipeImage url={r.image_url} title={r.title} className="aspect-[4/3] w-full" />
              <div className="p-2.5">
                <h2 className="line-clamp-2 text-sm font-semibold leading-5">{r.title}</h2>
                <p className="mt-0.5 text-xs text-muted">
                  {[r.dish_type, r.protein].filter(Boolean).join(" · ")}
                  {r.rating ? ` · ${"★".repeat(r.rating)}` : ""}
                </p>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}
