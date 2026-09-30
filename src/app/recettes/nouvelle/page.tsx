"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/AppProvider";
import { RecipeImage } from "@/components/RecipeImage";
import { AISLES } from "@/lib/aisles";
import { matchIngredient, type AliasIndex } from "@/lib/catalog";
import { loadAliasIndex, loadCatalog } from "@/lib/data";
import { DISH_TYPES, PROTEINS, type Ingredient } from "@/lib/db";
import type { ImportedRecipe } from "@/lib/importRecipe";
import { SEASON_LABEL, type Season } from "@/lib/planner";
import { scaledQuantity } from "@/lib/shopping";
import { resizeImage } from "@/lib/resizeImage";
import { supabase } from "@/lib/supabase";
import { nameKey } from "@/lib/text";

const MEAT_RE = /\b(poulet|chicken|b(œ|oe)uf|beef|porc|pork|bacon|jambon|saucisses?|sausages?|thon|tuna|saumon|salmon|crevettes?|shrimps?|anchois|anchov\w*|dinde|turkey|agneau|lamb|veau|lardons)\b/i;
const ALL_SEASONS: Season[] = ["printemps", "ete", "automne", "hiver"];

export default function Nouvelle() {
  const { householdId, session } = useApp();
  const router = useRouter();
  const [mode, setMode] = useState<"url" | "text">("url");
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ImportedRecipe | null>(null);
  const [catalog, setCatalog] = useState<Ingredient[]>([]);
  const [aliases, setAliases] = useState<AliasIndex | null>(null);
  const [links, setLinks] = useState<(string | null)[]>([]); // catalogue id per ingredient line
  const [meta, setMeta] = useState({ dish_type: "", protein: "", seasons: ALL_SEASONS });
  const [photo, setPhoto] = useState<File | null>(null);

  useEffect(() => {
    Promise.all([loadCatalog(), loadAliasIndex()])
      .then(([c, a]) => {
        setCatalog(c);
        setAliases(a);
      })
      .catch((e) => setError(`Catalogue inaccessible : ${e.message ?? e}`));
  }, []);

  const catalogById = useMemo(() => new Map(catalog.map((c) => [c.id, c])), [catalog]);

  async function analyse(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token}` },
        body: JSON.stringify(mode === "url" ? { url: input.trim() } : { text: input }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Import impossible.");
      const r = data as ImportedRecipe;
      if (!r.ingredients.length) throw new Error("Aucun ingrédient trouvé. Essayez de coller le texte de la recette.");
      setDraft(r);
      setLinks(r.ingredients.map((i) => (aliases ? matchIngredient(i.name, aliases) : null)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  async function newIngredient(index: number) {
    const name = prompt("Nom de l'ingrédient sur la liste d'épicerie :", draft?.ingredients[index].name ?? "");
    if (!name) return;
    const aisle = prompt(`Rayon ? (${AISLES.map(([k]) => k).join(", ")})`, "autre") ?? "autre";
    const { data, error } = await supabase()
      .from("ingredients")
      .insert({ household_id: householdId, name, aisle: AISLES.some(([k]) => k === aisle) ? aisle : "autre" })
      .select("id,household_id,name,aisle,pantry")
      .single();
    if (error) return setError(error.message);
    setCatalog([...catalog, data as Ingredient]);
    setLinks(links.map((l, i) => (i === index ? data.id : l)));
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const sb = supabase();
      let image_url = draft.image;
      if (photo) {
        const small = await resizeImage(photo);
        const path = `${householdId}/${crypto.randomUUID()}.webp`;
        const up = await sb.storage.from("recipe-images").upload(path, small, { contentType: small.type || "image/webp" });
        if (up.error) throw up.error;
        image_url = `storage:recipe-images/${path}`;
      }
      const { data: recipe, error } = await sb
        .from("recipes")
        .insert({
          household_id: householdId,
          title: draft.title || "Recette sans titre",
          source_type: mode === "url" ? "url" : "manual",
          source_url: mode === "url" ? input.trim() : null,
          image_url,
          servings: draft.servings,
          total_minutes: draft.totalMinutes,
          instructions: draft.instructions,
          dish_type: meta.dish_type || null,
          protein: meta.protein || null,
          seasons: meta.seasons,
        })
        .select("id")
        .single();
      if (error) throw error;
      const rows = draft.ingredients.map((i, position) => ({
        recipe_id: recipe.id,
        position,
        section: i.section,
        raw: i.raw,
        quantity: i.quantity,
        quantity_max: i.quantityMax,
        unit: i.unit,
        name: i.name,
        note: i.note,
        optional: i.optional,
        ingredient_id: links[position],
      }));
      const res = await sb.from("recipe_ingredients").insert(rows);
      if (res.error) throw res.error;
      // Remember the associations picked by hand, so the next recipe matches on its own.
      const learned = draft.ingredients
        .map((i, n) => ({ alias: nameKey(i.name), ingredient_id: links[n] }))
        .filter((a, n) => a.ingredient_id && a.alias && (!aliases || matchIngredient(draft.ingredients[n].name, aliases) !== a.ingredient_id));
      // One by one: an alias that already exists is simply skipped.
      for (const a of learned) await sb.from("ingredient_aliases").insert({ ...a, household_id: householdId });
      router.push(`/recettes/${recipe.id}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  const meat = draft?.ingredients.filter((i) => MEAT_RE.test(i.name)) ?? [];
  const unmatched = links.filter((l) => !l).length;

  if (!draft) {
    return (
      <div className="space-y-4">
        <button onClick={() => router.back()} className="text-sm text-muted">
          ← Retour
        </button>
        <h1 className="text-2xl font-bold">Nouvelle recette</h1>
        <div className="flex gap-2">
          <button className={mode === "url" ? "chip-on" : "chip"} onClick={() => setMode("url")}>
            Lien web
          </button>
          <button className={mode === "text" ? "chip-on" : "chip"} onClick={() => setMode("text")}>
            Coller le texte
          </button>
        </div>
        <form onSubmit={analyse} className="space-y-3">
          {mode === "url" ? (
            <input className="input" type="url" placeholder="https://…" value={input} onChange={(e) => setInput(e.target.value)} required />
          ) : (
            <textarea
              className="input min-h-72 font-mono text-sm"
              placeholder={"Titre\nPortions : 4\n\nIngrédients\n2 tasses de …\n\nPréparation\n1. …"}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              required
            />
          )}
          <button className="btn-primary w-full" disabled={busy || !aliases}>
            {busy ? "Lecture…" : "Lire la recette"}
          </button>
        </form>
        {error && <p className="text-sm text-red-700">{error}</p>}
        <p className="text-xs text-muted">
          Pour une recette en photo ou en PDF, copiez-en le texte (ou demandez-le à Claude) et utilisez « Coller le texte ».
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <button onClick={() => setDraft(null)} className="text-sm text-muted">
        ← Recommencer
      </button>
      {draft.image && !photo && <RecipeImage url={draft.image} title={draft.title} className="h-44 w-full rounded-2xl" />}
      <input className="input text-lg font-semibold" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder="Titre" />

      {meat.length > 0 && (
        <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          ⚠️ Contient peut-être de la viande ou du poisson : {meat.map((m) => m.name).join(", ")}.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-muted">
          Portions
          <input className="input mt-1" type="number" min={1} value={draft.servings ?? ""} onChange={(e) => setDraft({ ...draft, servings: e.target.value ? Number(e.target.value) : null })} />
        </label>
        <label className="text-xs text-muted">
          Photo {draft.image ? "(remplacer)" : ""}
          <input className="input mt-1 text-xs" type="file" accept="image/*" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
        </label>
        <select className="input" value={meta.dish_type} onChange={(e) => setMeta({ ...meta, dish_type: e.target.value })}>
          <option value="">Type de plat…</option>
          {DISH_TYPES.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
        <select className="input" value={meta.protein} onChange={(e) => setMeta({ ...meta, protein: e.target.value })}>
          <option value="">Protéine…</option>
          {PROTEINS.map((d) => (
            <option key={d}>{d}</option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap gap-2">
        {ALL_SEASONS.map((s) => {
          const on = meta.seasons.includes(s);
          return (
            <button key={s} className={on ? "chip-on" : "chip"} onClick={() => setMeta({ ...meta, seasons: on ? meta.seasons.filter((x) => x !== s) : [...meta.seasons, s] })}>
              {SEASON_LABEL[s]}
            </button>
          );
        })}
      </div>

      <section className="card divide-y divide-line">
        <h2 className="p-3 font-semibold">
          Ingrédients {unmatched > 0 && <span className="text-sm font-normal text-accent">· {unmatched} à associer</span>}
        </h2>
        {draft.ingredients.map((i, n) => (
          <div key={n} className="space-y-1.5 p-3 text-sm">
            <p>
              <span className="font-medium">{scaledQuantity(i.quantity, i.quantityMax, i.unit, 1)}</span> {i.name}
              {i.note && <span className="text-muted"> ({i.note})</span>}
            </p>
            <div className="flex gap-2">
              <select
                className={`input !py-1.5 text-sm ${links[n] ? "" : "border-accent"}`}
                value={links[n] ?? ""}
                onChange={(e) => setLinks(links.map((l, k) => (k === n ? e.target.value || null : l)))}
              >
                <option value="">— À associer —</option>
                {catalog.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button className="btn-ghost !px-3 !py-1.5" onClick={() => newIngredient(n)} title="Nouvel ingrédient">
                ＋
              </button>
            </div>
            {links[n] && catalogById.get(links[n]!)?.pantry && <p className="text-xs text-muted">Garde-manger</p>}
          </div>
        ))}
      </section>

      {draft.instructions.length > 0 && (
        <details className="card p-3 text-sm">
          <summary className="font-semibold">Préparation ({draft.instructions.length} étapes)</summary>
          <ol className="mt-2 list-decimal space-y-2 pl-5">
            {draft.instructions.map((s, n) => (
              <li key={n}>{s}</li>
            ))}
          </ol>
        </details>
      )}

      {error && <p className="text-sm text-red-700">{error}</p>}
      <button className="btn-primary w-full py-3" onClick={save} disabled={busy}>
        {busy ? "Enregistrement…" : "Enregistrer la recette"}
      </button>
    </div>
  );
}
