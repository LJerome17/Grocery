// Server routes that fetch web pages for recipes (/api/import, /api/image) are only for the recipe book's members:
// other households cannot save recipes, so they have no use for them.
import { createClient } from "@supabase/supabase-js";
import { SUPABASE_KEY, SUPABASE_URL } from "./supabase";

/** null when the token belongs to a member of the recipe book, else the response to send back. */
export async function bookMemberOnly(request: Request): Promise<Response | null> {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return Response.json({ error: "Non connecté." }, { status: 401 });
  const sb = createClient(SUPABASE_URL, SUPABASE_KEY, { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } });
  const { data: user, error } = await sb.auth.getUser(token);
  if (error || !user.user) return Response.json({ error: "Session expirée, reconnectez-vous." }, { status: 401 });
  // Row-level security only shows the households the user belongs to.
  const { data: book } = await sb.from("households").select("id").eq("is_book", true).maybeSingle();
  if (!book) return Response.json({ error: "Réservé au foyer Momo et Jéjé." }, { status: 403 });
  return null;
}
