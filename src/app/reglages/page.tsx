"use client";

import { useEffect, useState } from "react";
import { useApp } from "@/components/AppProvider";
import type { Household } from "@/lib/db";
import { syncStarterRecipes } from "@/lib/starter";
import { supabase } from "@/lib/supabase";
import { messageFr } from "@/lib/erreur";
import { locale, plural, tr, type Lang } from "@/lib/i18n";
import { accountName, protectAccess } from "@/lib/username";

function Rule({ label, help, value, min, max, onChange }: { label: string; help: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  return (
    <div className="flex items-center justify-between gap-3 py-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        <p className="text-xs text-muted">{help}</p>
      </div>
      <div className="flex items-center gap-2">
        <button className="btn-ghost h-8 w-8 !p-0" aria-label={tr(`Diminuer : ${label}`, `Decrease: ${label}`)} onClick={() => onChange(Math.max(min, value - 1))}>
          −
        </button>
        <span className="w-5 text-center font-semibold">{value}</span>
        <button className="btn-ghost h-8 w-8 !p-0" aria-label={tr(`Augmenter : ${label}`, `Increase: ${label}`)} onClick={() => onChange(Math.min(max, value + 1))}>
          +
        </button>
      </div>
    </div>
  );
}

type UsageRow = { name: string; is_book: boolean; members: number; created_at: string; last_day: string | null; days_30: number; opens_30: number; weeks: number; lists: number };

type UsageSummary = { accounts: number; active_7: number; active_30: number; visits_7: number; visits_30: number; households: number; lists_this_week: number; lists_next_week: number };

/** How the app is used (recipe book only): totals, then a leaderboard of the households. */
function Usage() {
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [sum, setSum] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    supabase()
      .rpc("usage_summary")
      .then(({ data, error }) => (error ? setError(messageFr(error)) : setSum(((data ?? []) as UsageSummary[])[0] ?? null)));
    supabase()
      .rpc("usage_stats")
      .then(({ data, error }) => (error ? setError(messageFr(error)) : setRows((data ?? []) as UsageRow[])));
  }, []);
  const tile = (value: number | undefined, label: string, sub?: string) => (
    <div className="rounded-xl bg-brand-soft p-3">
      <p className="text-2xl font-bold">{value ?? "—"}</p>
      <p className="text-xs">{label}</p>
      {sub && <p className="text-xs text-muted">{sub}</p>}
    </div>
  );
  const day = (d: string | null) => (d ? new Date(`${d.slice(0, 10)}T12:00:00`).toLocaleDateString(locale(), { day: "numeric", month: "short" }) : "—");
  return (
    <section className="card space-y-2 p-4">
      <h2 className="font-semibold">{tr("Utilisation", "Usage")}</h2>
      {error && <p className="text-sm text-red-700">{error}</p>}
      {sum && (
        <div className="grid grid-cols-2 gap-2">
          {tile(sum.active_30, tr("comptes actifs (30 jours)", "active accounts (30 days)"), tr(`${sum.active_7} cette semaine · ${sum.accounts} au total`, `${sum.active_7} this week · ${sum.accounts} in all`))}
          {tile(sum.visits_30, tr("visites (30 jours)", "visits (30 days)"), tr(`${sum.visits_7} ces 7 derniers jours`, `${sum.visits_7} in the last 7 days`))}
          {tile(sum.households, tr("foyers", "households"))}
          {tile(sum.lists_this_week, tr("foyers avec une liste cette semaine", "households with a list this week"), tr(`${sum.lists_next_week} pour la semaine suivante`, `${sum.lists_next_week} for next week`))}
        </div>
      )}
      <h3 className="pt-2 text-sm font-semibold">{tr("Classement des foyers", "Household leaderboard")}</h3>
      <p className="text-xs text-muted">{tr("Visites et jours d'utilisation sur 30 jours, semaines planifiées et listes faites depuis le début. Visites comptées depuis le 27 octobre 2026.", "Visits and days of use over 30 days, weeks planned and lists made since the start. Visits counted since October 27, 2026.")}</p>
      {rows && (
        <div className="-mx-4 overflow-x-auto px-4">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th className="py-1 pr-1 font-medium">#</th>
                <th className="py-1 pr-2 font-medium">{tr("Foyer", "Household")}</th>
                <th className="px-1 font-medium">{tr("Vu le", "Seen")}</th>
                <th className="px-1 text-right font-medium">{tr("Jours", "Days")}</th>
                <th className="px-1 text-right font-medium">{tr("Visites", "Visits")}</th>
                <th className="px-1 text-right font-medium">{tr("Sem.", "Weeks")}</th>
                <th className="pl-1 text-right font-medium">{tr("Listes", "Lists")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r, i) => (
                <tr key={i}>
                  <td className="py-1.5 pr-1 text-muted">{i + 1}</td>
                  <td className="py-1.5 pr-2">
                    {r.name}
                    <span className="block text-xs text-muted">
                      {plural(r.members, ["membre", "membres"], ["member", "members"])} · {tr("créé le", "created")} {day(r.created_at)}
                    </span>
                  </td>
                  <td className="px-1">{day(r.last_day)}</td>
                  <td className="px-1 text-right">{r.days_30}</td>
                  <td className="px-1 text-right">{r.opens_30}</td>
                  <td className="px-1 text-right">{r.weeks}</td>
                  <td className="pl-1 text-right">{r.lists}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Anonymous users can attach a username + password to keep access from another device. */
function ProtectAccount() {
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  async function protect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await protectAccess(login, password);
      setMsg(tr("C'est fait : connectez-vous avec ce nom d'utilisateur sur n'importe quel appareil.", "Done: sign in with this username on any device."));
    } catch (err) {
      setMsg(messageFr(err));
    }
    setBusy(false);
  }

  return (
    <form onSubmit={protect} className="space-y-2">
      <p className="text-sm">
        {tr("Vous utilisez l'application sans compte : l'accès est lié à ce navigateur. Choisissez un nom d'utilisateur pour le retrouver sur un autre appareil.", "You're using the app without an account: access is tied to this browser. Choose a username to get it back on another device.")}
      </p>
      <input className="input" autoComplete="username" autoCapitalize="none" placeholder={tr("Nom d'utilisateur", "Username")} value={login} onChange={(e) => setLogin(e.target.value)} required />
      <input className="input" type="password" autoComplete="new-password" placeholder={tr("Mot de passe (6 caractères minimum)", "Password (6 characters minimum)")} minLength={6} value={password} onChange={(e) => setPassword(e.target.value)} required />
      <button className="btn-primary w-full" disabled={busy}>
        {tr("Créer mon nom d'utilisateur", "Create my username")}
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
  const [name, setName] = useState<string | null>(null); // null = not editing

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

  /** A new invite code: the old one stops working (someone shared it too widely, or left the household). */
  async function newCode() {
    if (!confirm(tr("Créer un nouveau code ? L'ancien ne fonctionnera plus.", "Create a new code? The old one will stop working."))) return;
    const code = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(16).padStart(2, "0")).join("");
    await update({ invite_code: code });
  }

  async function leave() {
    const alone = members.length <= 1;
    // The recipe book must keep someone who can change its recipes (the database refuses too).
    if (alone && household!.is_book) {
      alert(tr("Vous êtes le seul membre du livre de recettes : invitez quelqu'un d'autre avant de le quitter.", "You're the only member of the recipe book: invite someone else before leaving it."));
      return;
    }
    const warning = alone
      ? tr("Vous êtes le seul membre : les semaines et les listes de ce foyer ne seront plus accessibles. Quitter quand même ?", "You're the only member: this household's weeks and lists will no longer be accessible. Leave anyway?")
      : tr("Quitter ce foyer ? Vous pourrez en créer un autre ou en rejoindre un avec un code.", "Leave this household? You can create another one or join one with a code.");
    if (!confirm(warning)) return;
    await supabase().from("household_members").delete().eq("household_id", household!.id).eq("user_id", session!.user.id);
    await reloadHousehold();
  }

  async function sync() {
    setSyncing(true);
    setSyncMsg(null);
    try {
      const r = await syncStarterRecipes(household!.id, (d, t) => setSyncMsg(`${tr("Mise à jour : ", "Updating: ")}${d} / ${t}`));
      setSyncMsg(`${plural(r.updated, ["recette mise à jour", "recettes mises à jour"], ["recipe updated", "recipes updated"])}${r.added ? `, ${plural(r.added, ["ajoutée", "ajoutées"], ["added", "added"])}` : ""}. ${tr("Refaites la liste d'épicerie pour en profiter.", "Make the grocery list again to get them.")}`);
    } catch (e) {
      setSyncMsg(messageFr(e));
    }
    setSyncing(false);
  }

  async function copyInvite() {
    const text = tr(`Rejoignez notre foyer sur ${window.location.origin} avec le code : ${household!.invite_code}`, `Join our household on ${window.location.origin} with the code: ${household!.invite_code}`);
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
      <h1 className="text-2xl font-bold">{tr("Réglages", "Settings")}</h1>

      <section className="card p-4">
        {name === null ? (
          <div className="flex items-center justify-between gap-2">
            <h2 className="font-semibold">{household.name}</h2>
            <button className="text-xs text-muted underline" onClick={() => setName(household.name)}>
              {tr("Renommer", "Rename")}
            </button>
          </div>
        ) : (
          <form
            className="flex gap-2"
            onSubmit={async (e) => {
              e.preventDefault();
              if (name.trim() && name.trim() !== household.name) await update({ name: name.trim() });
              setName(null);
            }}
          >
            <input className="input" aria-label={tr("Nom du foyer", "Household name")} value={name} maxLength={60} autoFocus onChange={(e) => setName(e.target.value)} />
            <button className="btn-primary">{tr("OK", "OK")}</button>
          </form>
        )}
        <p className="mt-1 text-sm text-muted">
          {plural(members.length, ["membre", "membres"], ["member", "members"])}
          {members.some((m) => m.display_name) ? `${tr(" : ", ": ")}${members.map((m) => m.display_name ?? "?").join(", ")}` : ""}
        </p>
        <div className="mt-3 flex items-center justify-between rounded-xl bg-brand-soft p-3">
          <div>
            <p className="text-xs text-muted">{tr("Code d'invitation", "Invite code")}</p>
            <p className="font-mono text-lg font-bold tracking-widest">{household.invite_code}</p>
          </div>
          <button className="btn-primary" onClick={copyInvite}>
            {copied ? tr("Copié ✓", "Copied ✓") : tr("Partager", "Share")}
          </button>
        </div>
        <button className="mt-2 text-xs text-muted underline" onClick={newCode}>
          {tr("Créer un nouveau code d'invitation", "Create a new invite code")}
        </button>
        <p className="mt-2 text-xs text-muted">{tr("Votre conjoint·e crée son compte, puis choisit « Rejoindre un foyer existant » avec ce code.", "Your partner creates an account, then chooses “Join an existing household” with this code.")}</p>
      </section>

      <section className="card space-y-2 p-4">
        <h2 className="font-semibold">{tr("Langue", "Language")}</h2>
        <div className="flex gap-2">
          {([["fr", "Français"], ["en", "English"]] as [Lang, string][]).map(([l, name]) => (
            <button key={l} className={household.lang === l ? "chip-on" : "chip"} onClick={() => update({ lang: l })}>
              {name}
            </button>
          ))}
        </div>
        <p className="text-xs text-muted">
          {tr("La liste d'épicerie prend la nouvelle langue la prochaine fois que vous la faites. Les recettes ne sont jamais traduites.", "The grocery list switches language the next time you make it. Recipes are never translated.")}
        </p>
      </section>

      <section className="card divide-y divide-line px-4">
        <h2 className="py-3 font-semibold">{tr("Variété des suggestions", "Variety of suggestions")}</h2>
        <Rule label={tr("Même type de plat", "Same type of dish")} help={tr("Maximum par semaine (ex. 2 ramen)", "Maximum per week (e.g. 2 ramen)")} value={household.max_same_dish_type} min={1} max={7} onChange={(v) => update({ max_same_dish_type: v })} />
        <Rule label={tr("Même protéine", "Same protein")} help={tr("Maximum par semaine (ex. 3 tofu)", "Maximum per week (e.g. 3 tofu)")} value={household.max_same_protein} min={1} max={7} onChange={(v) => update({ max_same_protein: v })} />
        <Rule label={tr("Pause avant de revoir une recette", "Break before a recipe comes back")} help={tr("En semaines", "In weeks")} value={household.repeat_cooldown_weeks} min={0} max={12} onChange={(v) => update({ repeat_cooldown_weeks: v })} />
      </section>

      {household.is_book && (
      <section className="card space-y-2 p-4">
        <h2 className="font-semibold">{tr("Recettes de départ", "Starter recipes")}</h2>
        <p className="text-sm text-muted">{tr("Applique les dernières corrections (ingrédients, étapes, liens) sans toucher à vos préférences, et ajoute les nouvelles recettes.", "Applies the latest fixes (ingredients, steps, links) without touching your preferences, and adds the new recipes.")}</p>
        <button className="btn-ghost w-full" onClick={sync} disabled={syncing}>
          {syncing ? syncMsg ?? tr("Mise à jour…", "Updating…") : tr("Mettre à jour les recettes de départ", "Update the starter recipes")}
        </button>
        {!syncing && syncMsg && <p className="text-sm text-muted">{syncMsg}</p>}
      </section>
      )}

      {household.is_book && <Usage />}

      <section className="card p-4 text-sm">
        {session?.user.is_anonymous ? <ProtectAccount /> : <p className="text-muted">{tr("Connecté : ", "Signed in: ")}{accountName(session?.user.email, session?.user.user_metadata?.username)}</p>}
        <button className="btn-ghost mt-3 w-full" onClick={leave}>
          {tr("Quitter ce foyer", "Leave this household")}
        </button>
        {!session?.user.is_anonymous && (
          <button className="btn-ghost mt-3 w-full" onClick={() => supabase().auth.signOut()}>
            {tr("Se déconnecter", "Sign out")}
          </button>
        )}
      </section>
    </div>
  );
}
