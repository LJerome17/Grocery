"use client";

import { useEffect, useState } from "react";
import { useApp } from "@/components/AppProvider";
import type { Household } from "@/lib/db";
import { syncStarterRecipes } from "@/lib/starter";
import { supabase } from "@/lib/supabase";
import { messageFr } from "@/lib/erreur";

function Rule({ label, help, value, min, max, onChange }: { label: string; help: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted">{help}</p>
      </div>
      <div className="flex items-center gap-2">
        <button className="btn-ghost h-8 w-8 !p-0" onClick={() => onChange(Math.max(min, value - 1))}>
          −
        </button>
        <span className="w-5 text-center font-semibold">{value}</span>
        <button className="btn-ghost h-8 w-8 !p-0" onClick={() => onChange(Math.min(max, value + 1))}>
          +
        </button>
      </div>
    </div>
  );
}

/** Anonymous users can attach an email + password to keep access from another device. */
function ProtectAccount() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function protect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    const sb = supabase();
    const a = await sb.auth.updateUser({ email });
    const b = a.error ? a : await sb.auth.updateUser({ password });
    setMsg(b.error ? messageFr(b.error) : "C'est fait : vous pouvez vous connecter avec ce courriel sur n'importe quel appareil.");
    setBusy(false);
  }

  return (
    <form onSubmit={protect} className="space-y-2">
      <p className="text-sm">
        Vous utilisez l&apos;app sans compte : l&apos;accès est lié à ce navigateur. Ajoutez un courriel pour le retrouver sur un autre appareil.
      </p>
      <input className="input" type="email" placeholder="Courriel" value={email} onChange={(e) => setEmail(e.target.value)} required />
      <input className="input" type="password" placeholder="Mot de passe (6 caractères minimum)" minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} required />
      <button className="btn-primary w-full" disabled={busy}>
        Protéger avec un courriel
      </button>
      {msg && <p className="text-sm text-muted">{msg}</p>}
    </form>
  );
}

export default function Reglages() {
  const { household, session, reloadHousehold } = useApp();
  const [members, setMembers] = useState<{ display_name: string | null; user_id: string }[]>([]);
  const [copied, setCopied] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);

  useEffect(() => {
    if (!household) return;
    supabase()
      .from("household_members")
      .select("display_name,user_id")
      .eq("household_id", household.id)
      .then(({ data }) => setMembers(data ?? []));
  }, [household]);

  if (!household) return null;

  async function update(patch: Partial<Household>) {
    await supabase().from("households").update(patch).eq("id", household!.id);
    await reloadHousehold();
  }

  async function leave() {
    const alone = members.length <= 1;
    const warning = alone
      ? "Vous êtes le seul membre : les recettes de ce foyer ne seront plus accessibles. Quitter quand même ?"
      : "Quitter ce foyer ? Vous pourrez en créer un autre ou en rejoindre un avec un code.";
    if (!confirm(warning)) return;
    await supabase().from("household_members").delete().eq("household_id", household!.id).eq("user_id", session!.user.id);
    await reloadHousehold();
  }

  async function sync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await syncStarterRecipes(household!.id, (d, t) => setSyncMsg(`Mise à jour : ${d} / ${t}`));
      setSyncMsg(`${r.updated} recette${r.updated > 1 ? "s" : ""} mise${r.updated > 1 ? "s" : ""} à jour${r.added ? `, ${r.added} ajoutée${r.added > 1 ? "s" : ""}` : ""}. Refaites la liste d'épicerie pour en profiter.`);
    } catch (e) {
      setSyncMsg(messageFr(e));
    }
    setSyncing(false);
  }

  async function copyInvite() {
    const text = `Rejoignez notre foyer sur ${window.location.origin} avec le code : ${household!.invite_code}`;
    try {
      if (navigator.share) await navigator.share({ text });
      else {
        await navigator.clipboard.writeText(text);
        setCopied(true);
      }
    } catch {
      /* share cancelled */
    }
  }

  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Réglages</h1>

      <section className="card p-4">
        <h2 className="font-semibold">{household.name}</h2>
        <p className="mt-1 text-sm text-muted">
          {members.length} membre{members.length > 1 ? "s" : ""}
          {members.some((m) => m.display_name) ? ` : ${members.map((m) => m.display_name ?? "?").join(", ")}` : ""}
        </p>
        <div className="mt-3 flex items-center justify-between rounded-xl bg-brand-soft p-3">
          <div>
            <p className="text-xs text-muted">Code d&apos;invitation</p>
            <p className="font-mono text-lg font-bold tracking-widest">{household.invite_code}</p>
          </div>
          <button className="btn-primary" onClick={copyInvite}>
            {copied ? "Copié ✓" : "Partager"}
          </button>
        </div>
        <p className="mt-2 text-xs text-muted">Votre conjoint·e crée son compte, puis choisit « Rejoindre un foyer » avec ce code.</p>
      </section>

      <section className="card divide-y divide-line px-4">
        <h2 className="py-3 font-semibold">Variété des suggestions</h2>
        <Rule label="Même type de plat" help="Maximum par semaine (ex. 1 ramen)" value={household.max_same_dish_type} min={1} max={7} onChange={(v) => update({ max_same_dish_type: v })} />
        <Rule label="Même protéine" help="Maximum par semaine (ex. 2 tofu)" value={household.max_same_protein} min={1} max={7} onChange={(v) => update({ max_same_protein: v })} />
        <Rule label="Pause avant de revoir une recette" help="En semaines" value={household.repeat_cooldown_weeks} min={0} max={12} onChange={(v) => update({ repeat_cooldown_weeks: v })} />
      </section>

      {household.is_book && (
      <section className="card space-y-2 p-4">
        <h2 className="font-semibold">Recettes de départ</h2>
        <p className="text-sm text-muted">Applique les dernières corrections (ingrédients, étapes, liens) sans toucher à vos préférences, et ajoute les nouvelles recettes.</p>
        <button className="btn-ghost w-full" onClick={sync} disabled={syncing}>
          {syncing ? syncMsg ?? "Mise à jour…" : "Mettre à jour les recettes de départ"}
        </button>
        {!syncing && syncMsg && <p className="text-sm text-muted">{syncMsg}</p>}
      </section>
      )}

      <section className="card p-4 text-sm">
        {session?.user.is_anonymous ? <ProtectAccount /> : <p className="text-muted">Connecté : {session?.user.email}</p>}
        <button className="btn-ghost mt-3 w-full" onClick={leave}>
          Quitter ce foyer
        </button>
        {!session?.user.is_anonymous && (
          <button className="btn-ghost mt-3 w-full" onClick={() => supabase().auth.signOut()}>
            Se déconnecter
          </button>
        )}
      </section>
    </div>
  );
}
