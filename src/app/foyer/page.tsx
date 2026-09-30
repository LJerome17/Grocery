"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useApp } from "@/components/AppProvider";
import { LangPicker } from "@/components/LangPicker";
import { messageFr } from "@/lib/erreur";
import { tr } from "@/lib/i18n";
import { protectAccess } from "@/lib/username";
import { supabase } from "@/lib/supabase";

export default function Foyer() {
  const { session, household, reloadHousehold, lang } = useApp();
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
    const { data: id, error } = await supabase().rpc("create_household", { p_name: name, p_display_name: displayName || null });
    if (error) {
      setError(messageFr(error));
      setBusy(false);
      return;
    }
    // The language picked on this page becomes the household's.
    if (lang !== "fr") await supabase().from("households").update({ lang }).eq("id", id as string);
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
    if (error) setError(error.message.includes("invalide") ? tr("Code d'invitation invalide.", "Invalid invite code.") : messageFr(error));
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
        <p className="text-muted">{tr(`Bienvenue, ${household.name} !`, `Welcome, ${household.name}!`)}</p>
        {error && <p className="text-sm text-red-700">{error}</p>}
        <button className="btn-primary" onClick={() => router.push("/semaine")}>
          {tr("Planifier la semaine", "Plan the week")}
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
      <LangPicker />
      <h1 className="text-2xl font-bold">{tr("Votre foyer", "Your household")}</h1>
      <p className="text-sm text-muted">
        {tr("Un foyer regroupe les personnes qui partagent les recettes, la semaine et la liste d'épicerie.", "A household is the people who share the recipes, the week and the grocery list.")}
      </p>
      <input className="input" placeholder={tr("Votre prénom (facultatif)", "Your first name (optional)")} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
      {session.user.is_anonymous && (
        <div className="card space-y-2 p-5">
          <h2 className="font-semibold">{tr("Nom d'utilisateur (facultatif)", "Username (optional)")}</h2>
          <p className="text-xs text-muted">{tr("Pour retrouver votre foyer sur un autre appareil. Sans lui, l'accès reste lié à ce navigateur.", "To find your household on another device. Without it, access stays tied to this browser.")}</p>
          <input className="input" autoComplete="username" autoCapitalize="none" placeholder={tr("Nom d'utilisateur", "Username")} value={login} onChange={(e) => setLogin(e.target.value)} />
          {login.trim() && (
            <input className="input" type="password" autoComplete="new-password" placeholder={tr("Mot de passe (6 caractères minimum)", "Password (6 characters minimum)")} minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} required />
          )}
        </div>
      )}

      <form onSubmit={create} className="card space-y-3 p-5">
        <h2 className="font-semibold">{tr("Créer un foyer", "Create a household")}</h2>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} required />
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? tr("Création…", "Creating…") : tr("Créer", "Create")}
        </button>
      </form>

      <form onSubmit={join} className="card space-y-3 p-5">
        <h2 className="font-semibold">{tr("Rejoindre un foyer existant", "Join an existing household")}</h2>
        <input className="input" placeholder={tr("Code d'invitation (dans Réglages)", "Invite code (in Settings)")} value={code} onChange={(e) => setCode(e.target.value)} required />
        <button className="btn-ghost w-full" disabled={busy}>
          {tr("Rejoindre", "Join")}
        </button>
      </form>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {session.user.is_anonymous && (
        <Link href="/connexion" className="block text-center text-sm text-muted underline">
          {tr("J'ai déjà un nom d'utilisateur", "I already have a username")}
        </Link>
      )}
    </div>
  );
}
