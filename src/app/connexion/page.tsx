"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { LangPicker } from "@/components/LangPicker";
import { messageFr, UserMessage } from "@/lib/erreur";
import { tr } from "@/lib/i18n";
import { loginEmail, protectAccess, usernameRule } from "@/lib/username";

export default function Connexion() {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [login, setLogin] = useState("");
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
    try {
      if (mode === "login") {
        const email = loginEmail(login);
        if (!email) throw new UserMessage(tr("Nom d'utilisateur invalide.", "Invalid username."));
        const { error } = await sb.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        // A new account is an anonymous access that immediately gets its username and password.
        if (!(await sb.auth.getSession()).data.session) {
          const { error } = await sb.auth.signInAnonymously();
          if (error) throw error;
        }
        await protectAccess(login, password);
      }
      router.push("/semaine"); // no household yet: the route guard sends to /foyer
    } catch (err) {
      setError(messageFr(err));
    }
    setBusy(false);
  }

  async function anonymous() {
    setBusy(true);
    setError(null);
    const { error } = await supabase().auth.signInAnonymously();
    if (error) setError(tr("L'accès sans compte n'est pas activé pour l'instant. Créez un compte ci-dessus.", "Access without an account is not enabled for now. Create an account above."));
    else router.push("/foyer");
    setBusy(false);
  }

  return (
    <div className="pt-10">
      <div className="mb-8 text-center">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/logo.webp" alt="" width={320} height={320} className="mx-auto w-36" />
        <h1 className="mt-3 text-2xl font-bold">Momo et Jéjé cuisinent végé</h1>
        <p className="mt-1 text-sm text-muted">{tr("Les recettes de la semaine et la liste d'épicerie, sans y penser.", "The week's recipes and the grocery list, without thinking about it.")}</p>
        <div className="mt-4">
          <LangPicker />
        </div>
      </div>

      <form onSubmit={submit} className="card space-y-3 p-5">
        <div className="mb-2 flex gap-2">
          <button type="button" onClick={() => setMode("login")} className={mode === "login" ? "chip-on" : "chip"}>
            {tr("Se connecter", "Sign in")}
          </button>
          <button type="button" onClick={() => setMode("signup")} className={mode === "signup" ? "chip-on" : "chip"}>
            {tr("Créer un compte", "Create an account")}
          </button>
        </div>
        <input className="input" autoComplete="username" autoCapitalize="none" placeholder={tr("Nom d'utilisateur", "Username")} value={login} onChange={(e) => setLogin(e.target.value)} required />
        {mode === "signup" && <p className="text-xs text-muted">{usernameRule()}</p>}
        <input
          className="input"
          type="password"
          autoComplete={mode === "login" ? "current-password" : "new-password"}
          placeholder={tr("Mot de passe (6 caractères minimum)", "Password (6 characters minimum)")}
          minLength={6}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <p className="text-sm text-red-700">{error}</p>}
        {message && <p className="text-sm text-brand">{message}</p>}
        <button className="btn-primary w-full" disabled={busy}>
          {busy ? "…" : mode === "login" ? tr("Se connecter", "Sign in") : tr("Créer mon compte", "Create my account")}
        </button>
      </form>
      <button className="btn-ghost mt-4 w-full" onClick={anonymous} disabled={busy}>
        {tr("Continuer sans compte", "Continue without an account")}
      </button>
    </div>
  );
}
