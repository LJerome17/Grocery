"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useApp } from "@/components/AppProvider";
import { messageFr, UserMessage } from "@/lib/erreur";
import { RecipeImage } from "@/components/RecipeImage";
import { AISLES, aisleLabel } from "@/lib/aisles";
import { matchIngredient, type AliasIndex } from "@/lib/catalog";
import { loadAliasIndex, loadCatalog } from "@/lib/data";
import { DISH_TYPES, PROTEINS, catalogName, dishTypeLabel, proteinLabel, type Ingredient } from "@/lib/db";
import { plural, tr } from "@/lib/i18n";
import type { ImportedRecipe } from "@/lib/importRecipe";
import { seasonLabel, type Season } from "@/lib/planner";
import { resizeImage } from "@/lib/resizeImage";
import { supabase } from "@/lib/supabase";
import { nameKey } from "@/lib/text";

const MEAT_RE = /\b(poulet|chicken|b(œ|oe)uf|beef|porc|pork|bacon|jambon|saucisses?|sausages?|thon|tuna|saumon|salmon|crevettes?|shrimps?|anchois|anchov\w*|dinde|turkey|agneau|lamb|veau|lardons)\b/i;
const ALL_SEASONS: Season[] = ["printemps", "ete", "automne", "hiver"];

export default function Nouvelle() {
  const { household, householdId, session } = useApp();
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
      .catch((e) => setError(tr(`Catalogue inaccessible : ${messageFr(e)}`, `Catalogue unavailable: ${messageFr(e)}`)));
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
      if (!res.ok) throw data.error ? new Error(data.error) : new UserMessage(tr("Import impossible.", "Import failed."));
      const r = data as ImportedRecipe;
      if (!r.ingredients.length) throw new UserMessage(tr("Aucun ingrédient trouvé. Essayez de coller le texte de la recette.", "No ingredients found. Try pasting the recipe text."));
      setDraft(r);
      setLinks(r.ingredients.map((i) => (aliases ? matchIngredient(i.name, aliases) : null)));
    } catch (e) {
      setError(messageFr(e));
    }
    setBusy(false);
  }

  async function newIngredient(index: number) {
    const name = prompt(tr("Nom de l'ingrédient sur la liste d'épicerie :", "Ingredient name on the grocery list:"), draft?.ingredients[index].name ?? "");
    if (!name) return;
    const aisle = prompt(tr(`Rayon ? (${AISLES.map(([k]) => k).join(", ")})`, `Aisle? (${AISLES.map(([k]) => `${k} = ${aisleLabel(k)}`).join(", ")})`), "autre") ?? "autre";
    const { data, error } = await supabase()
      .from("ingredients")
      .insert({ household_id: householdId, name, aisle: AISLES.some(([k]) => k === aisle) ? aisle : "autre" })
      .select("id,household_id,name,aisle,pantry,count_unit,equiv")
      .single();
    if (error) return setError(messageFr(error));
    setCatalog([...catalog, data as Ingredient]);
    setLinks(links.map((l, i) => (i === index ? data.id : l)));
  }

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      const sb = supabase();
      const store = async (file: File) => {
        const small = await resizeImage(file);
        const path = `${householdId}/${crypto.randomUUID()}.webp`;
        const up = await sb.storage.from("recipe-images").upload(path, small, { contentType: small.type || "image/webp" });
        if (up.error) throw up.error;
        return `storage:recipe-images/${path}`;
      };
      let image_url = draft.image;
      if (photo) image_url = await store(photo);
      else if (draft.image && /^https?:\/\//.test(draft.image)) {
        // The site's picture is copied (reduced) so the recipe keeps it if the site removes it; else the link stays.
        try {
          const res = await fetch(`/api/image?url=${encodeURIComponent(draft.image)}`, { headers: { Authorization: `Bearer ${session?.access_token}` } });
          if (res.ok) image_url = await store(new File([await res.blob()], "photo"));
        } catch {
          // Keep the original link.
        }
      }
      const { data: recipe, error } = await sb
        .from("recipes")
        .insert({
          household_id: householdId,
          title: draft.title || tr("Recette sans titre", "Untitled recipe"),
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
      setError(messageFr(e));
      setBusy(false);
    }
  }

  const meat = draft?.ingredients.filter((i) => MEAT_RE.test(i.name)) ?? [];
  const unmatched = links.filter((l) => !l).length;

  if (household && !household.is_book) {
    return (
      <div className="card mt-10 space-y-3 p-5 text-center">
        <p>{tr("Les recettes sont celles de Momo et Jéjé : seuls eux peuvent en ajouter.", "The recipes belong to Momo and Jéjé: only they can add new ones.")}</p>
        <button onClick={() => router.back()} className="btn-ghost">
          ← Retour
        </button>
      </div>
    );
  }

  if (!draft) {
    return (
      <div className="space-y-4">
        <button onClick={() => router.back()} className="text-sm text-muted">
          ← Retour
        </button>
        <h1 className="text-2xl font-bold">{tr("Nouvelle recette", "New recipe")}</h1>
        <div className="flex gap-2">
          <button className={mode === "url" ? "chip-on" : "chip"} onClick={() => setMode("url")}>
            {tr("Lien web", "Web link")}
          </button>
          <button className={mode === "text" ? "chip-on" : "chip"} onClick={() => setMode("text")}>
            {tr("Coller le texte", "Paste the text")}
          </button>
        </div>
        <form onSubmit={analyse} className="space-y-3">
          {mode === "url" ? (
            <input className="input" type="url" placeholder="https://…" value={input} onChange={(e) => setInput(e.target.value)} required />
          ) : (
            <textarea
              className="input min-h-72 font-mono text-sm"
              placeholder={tr("Titre\nPortions : 4\n\nIngrédients\n2 tasses de …\n\nPréparation\n1. …", "Title\nServings: 4\n\nIngredients\n2 cups of …\n\nMethod\n1. …")}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              required
            />
          )}
          <button className="btn-primary w-full" disabled={busy || !aliases}>
            {busy ? tr("Lecture…", "Reading…") : tr("Lire la recette", "Read the recipe")}
          </button>
        </form>
        {error && <p className="text-sm text-red-700">{error}</p>}
        <p className="text-xs text-muted">
          {tr("Pour une recette en photo ou en PDF, copiez-en le texte et utilisez « Coller le texte ».", "For a recipe in a photo or a PDF, copy its text and use “Paste the text”.")}
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <button onClick={() => setDraft(null)} className="text-sm text-muted">
        ← {tr("Recommencer", "Start over")}
      </button>
      {draft.image && !photo && <RecipeImage url={draft.image} title={draft.title} className="h-44 w-full rounded-2xl" />}
      <input className="input text-lg font-semibold" value={draft.title} onChange={(e) => setDraft({ ...draft, title: e.target.value })} placeholder={tr("Titre", "Title")} />

      {meat.length > 0 && (
        <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900">
          ⚠️ {tr("Contient peut-être de la viande ou du poisson :", "May contain meat or fish:")} {meat.map((m) => m.name).join(", ")}.
        </p>
      )}

      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs text-muted">
          {tr("Portions", "Servings")}
          <input className="input mt-1" type="number" min={1} value={draft.servings ?? ""} onChange={(e) => setDraft({ ...draft, servings: e.target.value ? Number(e.target.value) : null })} />
        </label>
        <label className="text-xs text-muted">
          Photo {draft.image ? tr("(remplacer)", "(replace)") : ""}
          <input className="input mt-1 text-xs" type="file" accept="image/*" onChange={(e) => setPhoto(e.target.files?.[0] ?? null)} />
        </label>
        <select className="input" value={meta.dish_type} onChange={(e) => setMeta({ ...meta, dish_type: e.target.value })}>
          <option value="">{tr("Type de plat…", "Dish type…")}</option>
          {DISH_TYPES.map((d) => (
            <option key={d} value={d}>
              {dishTypeLabel(d)}
            </option>
          ))}
        </select>
        <select className="input" value={meta.protein} onChange={(e) => setMeta({ ...meta, protein: e.target.value })}>
          <option value="">{tr("Protéine…", "Protein…")}</option>
          {PROTEINS.map((d) => (
            <option key={d} value={d}>
              {proteinLabel(d)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-wrap gap-2">
        {ALL_SEASONS.map((s) => {
          const on = meta.seasons.includes(s);
          return (
            <button key={s} className={on ? "chip-on" : "chip"} onClick={() => setMeta({ ...meta, seasons: on ? meta.seasons.filter((x) => x !== s) : [...meta.seasons, s] })}>
              {seasonLabel(s)}
            </button>
          );
        })}
      </div>

      <section className="card divide-y divide-line">
        <h2 className="p-3 font-semibold">
          {tr("Ingrédients", "Ingredients")} {unmatched > 0 && <span className="text-sm font-normal text-accent">· {tr(`${unmatched} à associer`, `${unmatched} to match`)}</span>}
        </h2>
        {draft.ingredients.map((i, n) => (
          <div key={n} className="space-y-1.5 p-3 text-sm">
            <p>{i.raw}</p>
            <div className="flex gap-2">
              <select
                className={`input !py-1.5 text-sm ${links[n] ? "" : "border-accent"}`}
                value={links[n] ?? ""}
                onChange={(e) => setLinks(links.map((l, k) => (k === n ? e.target.value || null : l)))}
              >
                <option value="">{tr("— À associer —", "— To match —")}</option>
                {catalog.map((c) => (
                  <option key={c.id} value={c.id}>
                    {catalogName(c)}
                  </option>
                ))}
              </select>
              <button className="btn-ghost !px-3 !py-1.5" onClick={() => newIngredient(n)} title={tr("Nouvel ingrédient", "New ingredient")}>
                ＋
              </button>
            </div>
            {links[n] && catalogById.get(links[n]!)?.pantry && <p className="text-xs text-muted">{tr("Garde-manger", "Pantry")}</p>}
          </div>
        ))}
      </section>

      {draft.instructions.length > 0 && (
        <details className="card p-3 text-sm">
          <summary className="font-semibold">{tr("Préparation", "Method")} ({plural(draft.instructions.length, ["étape", "étapes"], ["step", "steps"])})</summary>
          <ol className="mt-2 list-decimal space-y-2 pl-5">
            {draft.instructions.map((s, n) => (
              <li key={n}>{s}</li>
            ))}
          </ol>
        </details>
      )}

      {error && <p className="text-sm text-red-700">{error}</p>}
      {unmatched > 0 && (
        <p className="text-sm text-accent">
          {tr("Associez chaque ingrédient à un article du catalogue (ou créez-en un avec ＋) : c'est ce nom français qui apparaîtra sur la liste d'épicerie.", "Match each ingredient to a catalogue item (or create one with ＋): that name is what will appear on the grocery list.")}
        </p>
      )}
      <button className="btn-primary w-full py-3" onClick={save} disabled={busy || unmatched > 0}>
        {busy ? tr("Enregistrement…", "Saving…") : unmatched > 0 ? plural(unmatched, ["ingrédient à associer", "ingrédients à associer"], ["ingredient to match", "ingredients to match"]) : tr("Enregistrer la recette", "Save the recipe")}
      </button>
    </div>
  );
}
