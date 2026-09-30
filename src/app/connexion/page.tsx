"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { supabase } from "@/lib/supabase";

export default function Connexion() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setMessage(null);
    const sb = supabase();
    if (mode === "login") {
      const { error } = await sb.auth.signInWithPassword({ email, password });
      if (error) setError(error.message === "Invalid login credentials" ? "Courriel ou mot de passe incorrect." : error.message);
    } else {
      const { data, error } = await sb.auth.signUp({ email, password, options: { emailRedirectTo: window.location.origin } });
      if (error) setError(error.message);
      else if (!data.session) setMessage("Compte créé. Ouvrez le courriel de confirmation, puis revenez vous connecter.");
    }
    setBusy(false);
  }

  async function anonymous() {
    setBusy(true);
    setError(null);
    const { error } = await supabase().auth.signInAnonymously();
    if (error) setError("L'accès sans compte n'est pas activé pour l'instant. Créez un compte ci-dessus.");
    else router.push("/foyer");
    setBusy(false);
  }

  return (
    <div className="pt-10">
      <div className="mb-8 text-center">
        <div className="text-5xl">🥕</div>
        <h1 className="mt-3 text-2xl font-bold">Momo et Jéjé mangent végé</h1>
        <p className="mt-1 text-sm text-muted">Les recettes de la semaine et la liste d&apos;épicerie, sans y penser.</p>
      </div>

      <form onSubmit={submit} className="card space-y-3 p-5">
        <div className="mb-2 flex gap-2">
          <button type="button" onClick={() => setMode("login")} className={mode === "login" ? "chip-on" : "chip"}>
            Se connecter
          </button>
          <button type="button" onClick={() => setMode("signup")} className={mode === "signup" ? "chip-on" : "chip"}>
            Créer un compte
          </button>
        </div>
        <input className="input" type="email" autoComplete="email" placeholder="Courriel" value={email} onChange={(e) => setEmail(e.target.value)} required />
        <input
          className="input"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          placeholder="Mot de passe (6 caractères minimum)"
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <p className="text-sm text-red-700">{error}</p>}
        {message && <p className="text-sm text-brand">{message}</p>}
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? "…" : mode === "login" ? "Se connecter" : "Créer mon compte"}
        </button>
      </form>
      <button className="btn-ghost mt-4 w-full" onClick={anonymous} disabled={busy}>
        Continuer sans compte
      </button>
    </div>
  );
}
