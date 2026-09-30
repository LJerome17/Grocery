"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useApp } from "@/components/AppProvider";
import { messageFr } from "@/lib/erreur";
import { importStarterRecipes } from "@/lib/starter";
import { supabase } from "@/lib/supabase";

export default function Foyer() {
  const { session, household, reloadHousehold } = useApp();
  const router = useRouter();
  const [name, setName] = useState("Momo et Jéjé");
  const [postalCode, setPostalCode] = useState("H4C 0B8");
  const [displayName, setDisplayName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { data: id, error } = await supabase().rpc("create_household", { p_name: name, p_display_name: displayName || null });
    if (error) {
      setError(messageFr(error));
      setBusy(false);
      return;
    }
    // Postal code: which regional Maxi flyer to read.
    const cp = postalCode.trim().toUpperCase();
    if (/^[A-Z]\d[A-Z] ?\d[A-Z]\d$/.test(cp)) await supabase().from("households").update({ postal_code: cp }).eq("id", id as string);
    // Every new household starts with the Momo et Jéjé recipes (they can be removed afterwards).
    let ok = true;
    try {
      await importStarterRecipes(id as string, (d, t) => setProgress(`Ajout des recettes : ${d} / ${t}`));
    } catch (err) {
      ok = false;
      setError(`Foyer créé, mais l'ajout des recettes a échoué : ${messageFr(err)}`);
    }
    await reloadHousehold();
    if (ok) router.push("/semaine");
    setBusy(false);
  }

  async function join(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase().rpc("join_household", { p_code: code, p_display_name: displayName || null });
    if (error) setError(error.message.includes("invalide") ? "Code d'invitation invalide." : messageFr(error));
    else {
      await reloadHousehold();
      router.push("/semaine");
    }
    setBusy(false);
  }

  if (!session) return null;
  if (household) {
    return (
      <div className="space-y-3 pt-10 text-center">
        <p className="text-muted">Bienvenue, {household.name} !</p>
        {error && <p className="text-sm text-red-700">{error}</p>}
        <button className="btn-primary" onClick={() => router.push("/semaine")}>
          Planifier la semaine
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-5 pt-6">
      <div className="text-center">
        <div className="text-5xl">🥕</div>
        <p className="mt-2 font-semibold">Momo et Jéjé cuisinent végé</p>
      </div>
      <h1 className="text-2xl font-bold">Votre foyer</h1>
      <p className="text-sm text-muted">
        Un foyer regroupe les personnes qui partagent les recettes, la semaine et la liste d&apos;épicerie.
      </p>
      <input className="input" placeholder="Votre prénom (facultatif)" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />

      <form onSubmit={create} className="card space-y-3 p-5">
        <h2 className="font-semibold">Créer un foyer</h2>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        <label className="block">
          <span className="text-xs text-muted">Code postal (pour la circulaire Maxi de votre région)</span>
          <input
            className="input mt-1 uppercase"
            value={postalCode}
            maxLength={7}
            pattern="[A-Za-z]\d[A-Za-z] ?\d[A-Za-z]\d"
            title="Format : H4C 0B8"
            onChange={(e) => setPostalCode(e.target.value)}
            required
          />
        </label>
        <button className="btn-primary w-full" disabled={busy}>
          {busy && progress ? progress : "Créer"}
        </button>
      </form>

      <form onSubmit={join} className="card space-y-3 p-5">
        <h2 className="font-semibold">Rejoindre un foyer existant</h2>
        <input className="input" placeholder="Code d'invitation (dans Réglages)" value={code} onChange={(e) => setCode(e.target.value)} required />
        <button className="btn-ghost w-full" disabled={busy}>
          Rejoindre
        </button>
      </form>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {session.user.is_anonymous && (
        <Link href="/connexion" className="block text-center text-sm text-muted underline">
          J&apos;ai déjà un compte avec courriel
        </Link>
      )}
    </div>
  );
}
