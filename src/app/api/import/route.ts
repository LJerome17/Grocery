// Server-side recipe import: web pages cannot be read from the browser (CORS), so the phone sends the link here.
// POST { url } or { text }, with the user's Supabase access token as a Bearer token.
import { createClient } from "@supabase/supabase-js";
import { fetchRecipe } from "@/lib/importRecipe";
import { safeFetch } from "@/lib/safeFetch";
import { parseRecipeText } from "@/lib/parseRecipeText";
import { SUPABASE_KEY, SUPABASE_URL } from "@/lib/supabase";
import { cleanUrl } from "@/lib/url";
import { messageFr } from "@/lib/erreur";

export async function POST(request: Request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return Response.json({ error: "Non connecté." }, { status: 401 });
  const { data, error } = await createClient(SUPABASE_URL, SUPABASE_KEY).auth.getUser(token);
  if (error || !data.user) return Response.json({ error: "Session expirée, reconnectez-vous." }, { status: 401 });

  const body = (await request.json().catch(() => ({}))) as { url?: string; text?: string };
  try {
    if (body.url) return Response.json(await fetchRecipe(cleanUrl(body.url), safeFetch));
    if (body.text) return Response.json(parseRecipeText(body.text));
    return Response.json({ error: "Lien ou texte manquant." }, { status: 400 });
  } catch (e) {
    return Response.json({ error: messageFr(e) }, { status: 422 });
  }
}
