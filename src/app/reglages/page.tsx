"use client";

import { useEffect, useState } from "react";
import { useApp } from "@/components/AppProvider";
import type { Household } from "@/lib/db";
import { supabase } from "@/lib/supabase";

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

export default function Reglages() {
  const { household, session, reloadHousehold } = useApp();
  const [members, setMembers] = useState<{ display_name: string | null; user_id: string }[]>([]);
  const [copied, setCopied] = useState(false);

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

  async function copyInvite() {
    const text = `Rejoins notre foyer sur ${window.location.origin} avec le code : ${household!.invite_code}`;
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

      <section className="card p-4 text-sm">
        <p className="text-muted">Connecté : {session?.user.email}</p>
        <button className="btn-ghost mt-3 w-full" onClick={() => supabase().auth.signOut()}>
          Se déconnecter
        </button>
      </section>
    </div>
  );
}
