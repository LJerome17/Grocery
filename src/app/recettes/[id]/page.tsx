"use client";

import Link from "next/link";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { RecipeImage } from "@/components/RecipeImage";
import { DISH_TYPES, PROTEINS, RECIPE_COLUMNS, type Recipe, type RecipeIngredient } from "@/lib/db";
import { SEASON_LABEL, type Season } from "@/lib/planner";
import { scaledQuantity, scaleFactor } from "@/lib/shopping";
import { supabase } from "@/lib/supabase";

function RecipeView() {
  const { id } = useParams<{ id: string }>();
  const params = useSearchParams();
  const router = useRouter();
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [ingredients, setIngredients] = useState<RecipeIngredient[]>([]);
  const [portions, setPortions] = useState<number | null>(params.get("portions") ? Number(params.get("portions")) : null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    const sb = supabase();
    sb.from("recipes")
      .select(RECIPE_COLUMNS)
      .eq("id", id)
      .single()
      .then(({ data }) => setRecipe(data as Recipe));
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
    if (!recipe || !confirm(`Supprimer « ${recipe.title} » ?`)) return;
    await supabase().from("recipes").delete().eq("id", recipe.id);
    router.push("/recettes");
  }

  if (!recipe) return <p className="py-20 text-center text-muted">Chargement…</p>;

  const base = recipe.servings ?? 4;
  const shownPortions = portions ?? base;
  const factor = scaleFactor(shownPortions, recipe.servings);

  return (
    <article className="space-y-5">
      <button onClick={() => router.back()} className="text-sm text-muted">
        ← Retour
      </button>
      <RecipeImage url={recipe.image_url} title={recipe.title} className="-mx-4 h-56 w-[calc(100%+2rem)] max-w-none" />
      <header className="space-y-2">
        <h1 className="text-2xl font-bold leading-tight">{recipe.title}</h1>
        <p className="text-sm text-muted">
          {[recipe.dish_type, recipe.protein, recipe.total_minutes ? `${recipe.total_minutes} min` : null].filter(Boolean).join(" · ")}
        </p>
        <div className="flex items-center gap-1">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} className={`text-2xl ${recipe.rating && n <= recipe.rating ? "text-amber-500" : "text-line"}`} onClick={() => update({ rating: recipe.rating === n ? null : n })}>
              ★
            </button>
          ))}
          {recipe.source_url && (
            <a href={recipe.source_url} target="_blank" rel="noreferrer" className="ml-auto text-sm text-brand underline">
              Recette originale ↗
            </a>
          )}
        </div>
      </header>

      <section className="card p-4">
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Ingrédients</h2>
          <div className="flex items-center gap-2 text-sm">
            <button className="btn-ghost h-8 w-8 !p-0" onClick={() => setPortions(Math.max(1, shownPortions - 1))}>
              −
            </button>
            <span>{shownPortions} portions</span>
            <button className="btn-ghost h-8 w-8 !p-0" onClick={() => setPortions(shownPortions + 1)}>
              +
            </button>
          </div>
        </div>
        <ul className="space-y-1.5 text-sm">
          {ingredients.map((i, n) => {
            const header = i.section && (n === 0 || ingredients[n - 1].section !== i.section) ? i.section : null;
            return (
              <li key={i.id}>
                {header && <p className="mt-3 text-xs font-semibold uppercase tracking-wide text-muted">{header}</p>}
                <span className="font-medium">{scaledQuantity(i.quantity, i.quantity_max, i.unit, factor)}</span> {i.name}
                {i.note && <span className="text-muted"> ({i.note})</span>}
                {i.optional && <span className="text-muted"> (facultatif)</span>}
              </li>
            );
          })}
        </ul>
        {!recipe.servings && <p className="mt-3 text-xs text-muted">Nombre de portions d&apos;origine inconnu : 4 supposées.</p>}
      </section>

      {recipe.instructions.length > 0 && (
        <section className="card p-4">
          <h2 className="mb-3 font-semibold">Préparation</h2>
          <ol className="list-decimal space-y-3 pl-5 text-sm leading-6">
            {recipe.instructions.map((s, n) => (
              <li key={n}>{s}</li>
            ))}
          </ol>
        </section>
      )}

      <section className="card space-y-4 p-4">
        <button className="flex w-full items-center justify-between font-semibold" onClick={() => setEditing(!editing)}>
          Préférences {editing ? "▾" : "▸"}
        </button>
        {editing && (
          <>
            <div>
              <p className="mb-1 text-xs text-muted">Saisons où on la veut</p>
              <div className="flex flex-wrap gap-2">
                {(Object.keys(SEASON_LABEL) as Season[]).map((s) => {
                  const on = recipe.seasons.includes(s);
                  return (
                    <button key={s} className={on ? "chip-on" : "chip"} onClick={() => update({ seasons: on ? recipe.seasons.filter((x) => x !== s) : [...recipe.seasons, s] })}>
                      {SEASON_LABEL[s]}
                    </button>
                  );
                })}
              </div>
            </div>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Type de plat (variété)</span>
              <select className="input" value={recipe.dish_type ?? ""} onChange={(e) => update({ dish_type: e.target.value || null })}>
                <option value="">—</option>
                {DISH_TYPES.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Protéine (variété)</span>
              <select className="input" value={recipe.protein ?? ""} onChange={(e) => update({ protein: e.target.value || null })}>
                <option value="">—</option>
                {PROTEINS.map((d) => (
                  <option key={d}>{d}</option>
                ))}
              </select>
            </label>
            <label className="block">
              <span className="mb-1 block text-xs text-muted">Portions que donne la recette</span>
              <input className="input" type="number" min={1} value={recipe.servings ?? ""} onChange={(e) => update({ servings: e.target.value ? Number(e.target.value) : null })} />
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={recipe.active} onChange={(e) => update({ active: e.target.checked })} />
              Proposer cette recette dans les suggestions
            </label>
            <button className="btn-ghost w-full text-red-700" onClick={remove}>
              Supprimer la recette
            </button>
          </>
        )}
      </section>
      <Link href="/recettes" className="block text-center text-sm text-muted">
        Toutes les recettes
      </Link>
    </article>
  );
}

export default function RecipePage() {
  return (
    <Suspense fallback={<p className="py-20 text-center text-muted">Chargement…</p>}>
      <RecipeView />
    </Suspense>
  );
}
