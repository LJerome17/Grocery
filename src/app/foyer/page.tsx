"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useApp } from "@/components/AppProvider";
import { importStarterRecipes } from "@/lib/starter";
import { supabase } from "@/lib/supabase";

export default function Foyer() {
  const { session, household, reloadHousehold } = useApp();
  const router = useRouter();
  const [name, setName] = useState("Momo et Jéjé");
  const [displayName, setDisplayName] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase().rpc("create_household", { p_name: name, p_display_name: displayName || null });
    if (error) setError(error.message);
    else await reloadHousehold();
    setBusy(false);
  }

  async function join(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase().rpc("join_household", { p_code: code, p_display_name: displayName || null });
    if (error) setError(error.message.includes("invalide") ? "Code d'invitation invalide." : error.message);
    else await reloadHousehold();
    setBusy(false);
  }

  async function loadStarter() {
    if (!household) return;
    setBusy(true);
    setError(null);
    try {
      const n = await importStarterRecipes(household.id, (d, t) => setProgress(`${d} / ${t} recettes`));
      setProgress(`${n} recettes importées.`);
      router.push("/recettes");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    setBusy(false);
  }

  if (!session) return null;

  if (household) {
    return (
      <div className="space-y-4 pt-6">
        <h1 className="text-2xl font-bold">Bienvenue, {household.name} 🎉</h1>
        <div className="card space-y-3 p-5">
          <p>Voulez-vous partir avec les 68 recettes de Momo et Jéjé ? Vous pourrez retirer celles qui ne vous plaisent pas.</p>
          <button className="btn-primary w-full" onClick={loadStarter} disabled={busy}>
            {busy ? progress ?? "Import…" : "Importer les recettes de départ"}
          </button>
          <button className="btn-ghost w-full" onClick={() => router.push("/recettes")} disabled={busy}>
            Partir de zéro
          </button>
          {error && <p className="text-sm text-red-700">{error}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 pt-6">
      <div className="text-center">
        <div className="text-5xl">🥕</div>
        <p className="mt-2 font-semibold">Momo et Jéjé mangent végé</p>
      </div>
      <h1 className="text-2xl font-bold">Votre foyer</h1>
      <p className="text-sm text-muted">
        Un foyer regroupe les personnes qui partagent les recettes, la semaine et la liste d&apos;épicerie.
      </p>
      <input className="input" placeholder="Votre prénom (facultatif)" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />

      <form onSubmit={create} className="card space-y-3 p-5">
        <h2 className="font-semibold">Créer un foyer</h2>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        <button className="btn-primary w-full" disabled={busy}>
          Créer
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
