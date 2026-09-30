"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { RecipeImage } from "@/components/RecipeImage";
import { DISH_TYPES, PROTEINS, RECIPE_COLUMNS, dishTypeLabel, proteinLabel, type Recipe, type RecipeIngredient } from "@/lib/db";
import { plural, tr } from "@/lib/i18n";
import { SEASON_LABEL, seasonLabel, type Season } from "@/lib/planner";
import { supabase } from "@/lib/supabase";
import { useApp } from "@/components/AppProvider";

function RecipeView() {
  // Only the Momo et Jéjé household changes recipes; the others read them.
  const canEdit = !!useApp().household?.is_book;
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [ingredients, setIngredients] = useState<RecipeIngredient[]>([]);
  // Whole multiplier from the week (?fois=2); quantities are otherwise shown exactly as written.
  const times = Math.max(1, Math.round(Number(params.get("fois") ?? 1)) || 1);
  const [editing, setEditing] = useState(false);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    const sb = supabase();
    sb.from("recipes")
      .select(RECIPE_COLUMNS)
      .eq("id", id)
      .single()
      .then(({ data, error }) => {
        if (error || !data) setMissing(true);
        else setRecipe(data as Recipe);
      });
    sb.from("recipe_ingredients")
      .select("*")
      .eq("recipe_id", id)
      .order("position")
      .then(({ data }) => setIngredients((data ?? []) as RecipeIngredient[]));
  }, [id]);

  async function update(patch: Partial<Recipe>) {
    if (!recipe) return;
    setRecipe({ ...recipe, ...patch });
    await supabase().from("recipes").update(patch).eq("id", recipe.id);
  }

  async function remove() {
    if (!recipe || !confirm(tr(`Supprimer « ${recipe.title} » ?`, `Delete “${recipe.title}”?`))) return;
    await supabase().from("recipes").delete().eq("id", recipe.id);
    router.push("/recettes");
  }

  if (missing)
    return (
      <div className="py-20 text-center">
        <p className="text-muted">{tr("Recette introuvable.", "Recipe not found.")}</p>
        <Link href="/recettes" className="btn-ghost mt-4">
          {tr("Toutes les recettes", "All recipes")}
        </Link>
      </div>
    );
  if (!recipe) return <p className="py-20 text-center text-muted">{tr("Chargement…", "Loading…")}</p>;

  const base = recipe.servings ?? 4;

  return (
    <article className="space-y-5">
      <button onClick={() => router.back()} className="text-sm text-muted">
        ← {tr("Retour", "Back")}
      </button>
      <RecipeImage url={recipe.image_url} title={recipe.title} className="-mx-4 h-56 w-[calc(100%+2rem)] max-w-none" />
      <header className="space-y-2">
        <h1 className="text-2xl font-bold leading-tight">{recipe.title}</h1>
        <p className="text-sm text-muted">
          {[recipe.dish_type && dishTypeLabel(recipe.dish_type), recipe.protein && proteinLabel(recipe.protein), recipe.total_minutes ? `${recipe.total_minutes} min` : null].filter(Boolean).join(" · ")}
        </p>
        <div className="flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} disabled={!canEdit} aria-label={tr(`${n} étoile${n > 1 ? "s" : ""}`, `${n} star${n > 1 ? "s" : ""}`)} className={`text-2xl ${recipe.rating && n <= recipe.rating ? "text-amber-500" : "text-line"}`} onClick={() => update({ rating: recipe.rating === n ? null : n })}>
              ★
            </button>
          ))}
          {recipe.source_url && (
            <a href={recipe.source_url} target="_blank" rel="noreferrer" className="ml-auto text-sm text-brand underline">
              {tr("Recette originale", "Original recipe")} ↗
            </a>
          )}
        </div>
      </header>

      <section className="card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">{tr("Ingrédients", "Ingredients")}</h2>
          <span className="text-sm text-muted">
            {times > 1 ? tr(`Recette ×${times} · ${base * times} portions`, `Recipe ×${times} · ${base * times} servings`) : plural(base, ["portion", "portions"], ["serving", "servings"])}
          </span>
        </div>
        <ul className="space-y-1.5 text-sm">
          {ingredients.map((i, n) => {
            const header = i.section && (n === 0 || ingredients[n - 1].section !== i.section) ? i.section : null;
            return (
              <li key={i.id}>
                {header && <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted">{header}</p>}
                {i.raw}
              </li>
            );
          })}
        </ul>
        {times > 1 && <p className="mb-3 rounded-lg bg-brand-soft p-2 text-sm text-brand">{tr(`Recette ×${times} cette semaine : multipliez chaque quantité par ${times}.`, `Recipe ×${times} this week: multiply each quantity by ${times}.`)}</p>}
        {!recipe.servings && <p className="mt-3 text-xs text-muted">{canEdit ? tr("Nombre de portions inconnu : 4 supposées. Indiquez-le dans Préférences.", "Number of servings unknown: 4 assumed. Set it in Preferences.") : tr("Nombre de portions inconnu : 4 supposées.", "Number of servings unknown: 4 assumed.")}</p>}
      </section>

      {recipe.instructions.length > 0 && (
        <section className="card p-4">
          <h2 className="mb-3 font-semibold">{tr("Préparation", "Method")}</h2>
          <ol className="list-decimal space-y-3 pl-5 text-sm leading-6">
            {recipe.instructions.map((s, n) => (
              <li key={n}>{s}</li>
            ))}
          </ol>
        </section>
      )}

      {canEdit && (
      <section className="card space-y-4 p-4">
        <button className="flex w-full items-center justify-between font-semibold" onClick={() => setEditing(!editing)}>
          {tr("Préférences", "Preferences")} {editing ? "▾" : "▸"}
        </button>
        {editing && (
          <>
            <div>
              <p className="mb-1 text-xs text-muted">{tr("Saison", "Season")}</p>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(SEASON_LABEL) as Season[]).map((s) => {
                  const on = recipe.seasons.includes(s);
                  return (
                    <button key={s} className={on ? "chip-on" : "chip"} onClick={() => update({ seasons: on ? recipe.seasons.filter((x) => x !== s) : [...recipe.seasons, s] })}>
                      {seasonLabel(s)}
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">{tr("Type de plat (variété)", "Dish type (variety)")}</span>
              <select className="input" value={recipe.dish_type ?? ""} onChange={(e) => update({ dish_type: e.target.value || null })}>
                <option value="">—</option>
                {DISH_TYPES.map((d) => (
                  <option key={d} value={d}>
                    {dishTypeLabel(d)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">{tr("Protéine (variété)", "Protein (variety)")}</span>
              <select className="input" value={recipe.protein ?? ""} onChange={(e) => update({ protein: e.target.value || null })}>
                <option value="">—</option>
                {PROTEINS.map((d) => (
                  <option key={d} value={d}>
                    {proteinLabel(d)}
                  </option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">{tr("Portions que donne la recette", "Servings the recipe makes")}</span>
              <input className="input" type="number" min={1} value={recipe.servings ?? ""} onChange={(e) => update({ servings: e.target.value ? Number(e.target.value) : null })} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={recipe.active} onChange={(e) => update({ active: e.target.checked })} />
              {tr("Proposer cette recette dans les suggestions", "Include this recipe in suggestions")}
            </label>
            <button className="btn-ghost w-full text-red-700" onClick={remove}>
              {tr("Supprimer la recette", "Delete this recipe")}
            </button>
          </>
        )}
      </section>
      )}
      <Link href="/recettes" className="block text-center text-sm text-muted">
        {tr("Toutes les recettes", "All recipes")}
      </Link>
    </article>
  );
}

export default function RecipePage() {
  return (
    <Suspense fallback={<p className="py-20 text-center text-muted">{tr("Chargement…", "Loading…")}</p>}>
      <RecipeView />
    </Suspense>
  );
}
