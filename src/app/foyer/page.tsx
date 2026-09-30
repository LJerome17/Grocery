"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useApp } from "@/components/AppProvider";
import { messageFr } from "@/lib/erreur";
import { protectAccess } from "@/lib/username";
import { supabase } from "@/lib/supabase";

export default function Foyer() {
  const { session, household, reloadHousehold } = useApp();
  const router = useRouter();
  const [name, setName] = useState("Momo et Jéjé");
  const [displayName, setDisplayName] = useState("");
  const [code, setCode] = useState("");
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** Optional username chosen on this page: attached to the anonymous access before the household. */
  async function withUsername(): Promise<boolean> {
    if (!login.trim()) return true;
    try {
      await protectAccess(login, password);
      return true;
    } catch (err) {
      setError(messageFr(err));
      setBusy(false);
      return false;
    }
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    if (!(await withUsername())) return;
    const { error } = await supabase().rpc("create_household", { p_name: name, p_display_name: displayName || null });
    if (error) {
      setError(messageFr(error));
      setBusy(false);
      return;
    }
    // The recipes come from the Momo et Jéjé recipe book, shared read-only with every household.
    await reloadHousehold();
    router.push("/semaine");
    setBusy(false);
  }

  async function join(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    if (!(await withUsername())) return;
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
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.webp" alt="" width={320} height={320} className="mx-auto w-36" />
        <p className="mt-2 font-semibold">Momo et Jéjé cuisinent végé</p>
      </div>
      <h1 className="text-2xl font-bold">Votre foyer</h1>
      <p className="text-sm text-muted">
        Un foyer regroupe les personnes qui partagent les recettes, la semaine et la liste d&apos;épicerie.
      </p>
      <input className="input" placeholder="Votre prénom (facultatif)" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      {session.user.is_anonymous && (
        <div className="card space-y-2 p-5">
          <h2 className="font-semibold">Nom d&apos;utilisateur (facultatif)</h2>
          <p className="text-xs text-muted">Pour retrouver votre foyer sur un autre appareil. Sans lui, l&apos;accès reste lié à ce navigateur.</p>
          <input className="input" autoComplete="username" autoCapitalize="none" placeholder="Nom d'utilisateur" value={login} onChange={(e) => setLogin(e.target.value)} />
          {login.trim() && (
            <input className="input" type="password" autoComplete="new-password" placeholder="Mot de passe (6 caractères minimum)" minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} required />
          )}
        </div>
      )}

      <form onSubmit={create} className="card space-y-3 p-5">
        <h2 className="font-semibold">Créer un foyer</h2>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? "Création…" : "Créer"}
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
          J&apos;ai déjà un nom d&apos;utilisateur
        </Link>
      )}
    </div>
  );
}
