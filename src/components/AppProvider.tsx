"use client";

import type { Session } from "@supabase/supabase-js";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useState } from "react";
import type { Household } from "@/lib/db";
import { supabase } from "@/lib/supabase";

type AppState = {
  session: Session | null;
  household: Household | null;
  loading: boolean;
  reloadHousehold: () => Promise<void>;
};

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState & { householdId: string } {
  const s = useContext(Ctx);
  if (!s) throw new Error("useApp outside AppProvider");
  return { ...s, householdId: s.household?.id ?? "" };
}

const PUBLIC_PATHS = ["/connexion"];

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [household, setHousehold] = useState<Household | null>(null);
  const [authReady, setAuthReady] = useState(false);
  // User id whose household has been loaded ("" = signed out), to know when loading is over.
  const [loadedFor, setLoadedFor] = useState<string | null>(null);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    const sb = supabase();
    // No sign-up wall: a first visit gets an invisible anonymous identity (kept in the browser).
    // An email can be attached later in Réglages. People who signed out explicitly land on /connexion.
    sb.auth.getSession().then(async ({ data }) => {
      let s = data.session;
      if (!s && window.location.pathname !== "/connexion") {
        const anon = await sb.auth.signInAnonymously();
        s = anon.data.session;
      }
      setSession(s);
      setAuthReady(true);
    });
    const { data } = sb.auth.onAuthStateChange((_event, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id;
  const reloadHousehold = useCallback(async () => {
    if (!userId) {
      setHousehold(null);
      setLoadedFor("");
      return;
    }
    const { data } = await supabase()
      .from("household_members")
      .select("households(*)")
      .eq("user_id", userId)
      .order("household_id")
      .limit(1)
      .maybeSingle();
    setHousehold((data?.households as unknown as Household) ?? null);
    setLoadedFor(userId);
  }, [userId]);

  useEffect(() => {
    if (!authReady) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch on sign-in/out
    reloadHousehold();
  }, [authReady, reloadHousehold]);

  const loading = !authReady || loadedFor !== (userId ?? "");

  // Route guard: an identity first (anonymous is fine), then create or join a household.
  // /connexion stays reachable for anonymous visitors who want to use an existing account.
  useEffect(() => {
    if (loading) return;
    const onLogin = PUBLIC_PATHS.includes(pathname);
    if (!session) {
      if (!onLogin) router.replace("/connexion");
    } else if (onLogin) {
      if (!session.user.is_anonymous) router.replace(household ? "/semaine" : "/foyer");
    } else if (!household && pathname !== "/foyer") router.replace("/foyer");
    else if (household && pathname === "/") router.replace("/semaine");
  }, [loading, session, household, pathname, router]);

  return <Ctx.Provider value={{ session, household, loading, reloadHousehold }}>{children}</Ctx.Provider>;
}
