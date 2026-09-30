// Server-side recipe import: web pages cannot be read from the browser (CORS), so the phone sends the link here.
// POST { url } or { text }, with the user's Supabase access token as a Bearer token.
import { fetchRecipe } from "@/lib/importRecipe";
import { safeFetch } from "@/lib/safeFetch";
import { parseRecipeText } from "@/lib/parseRecipeText";
import { cleanUrl } from "@/lib/url";
import { bookMemberOnly } from "@/lib/bookAccess";
import { messageFr } from "@/lib/erreur";

export async function POST(request: Request) {
  const refused = await bookMemberOnly(request);
  if (refused) return refused;

  const body = (await request.json().catch(() => ({}))) as { url?: string; text?: string };
  try {
    if (body.url) return Response.json(await fetchRecipe(cleanUrl(body.url), safeFetch));
    if (body.text) return Response.json(parseRecipeText(body.text));
    return Response.json({ error: "Lien ou texte manquant." }, { status: 400 });
  } catch (e) {
    return Response.json({ error: messageFr(e) }, { status: 422 });
  }
}
