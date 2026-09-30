"use client";

import { useCallback, useEffect, useState } from "react";
import { loadCatalog, loadRecipeIngredients, loadRecipes } from "./data";
import type { Ingredient, Recipe, RecipeIngredient } from "./db";
import { messageFr } from "@/lib/erreur";

/** Recipes, their ingredients and the catalogue of a household. */
export function useKitchen(householdId: string) {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [ingredients, setIngredients] = useState<RecipeIngredient[]>([]);
  const [catalog, setCatalog] = useState<Ingredient[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!householdId) return;
    try {
      const [r, c] = await Promise.all([loadRecipes(householdId), loadCatalog()]);
      const ing = await loadRecipeIngredients(r.map((x) => x.id));
      setRecipes(r);
      setCatalog(c);
      setIngredients(ing);
      setError(null);
    } catch (e) {
      setError(messageFr(e));
    } finally {
      setLoading(false);
    }
  }, [householdId]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- initial fetch
    reload();
  }, [reload]);

  return { recipes, ingredients, catalog, loading, error, reload };
}
