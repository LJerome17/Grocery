import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

// Public values (the publishable key only grants what row-level security allows); env vars override them.
const URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "https://nptpjbncvqjyqeyroasg.supabase.co";
const KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? "sb_publishable_G6j5Daj3lqRQiNDEvhl6mQ_A9VK6IqG";

let client: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!client) client = createBrowserClient(URL, KEY);
  return client;
}

export const SUPABASE_URL = URL;
export const SUPABASE_KEY = KEY;
