// Server-side copy of a recipe's picture: the phone cannot read images from other sites (CORS), so it asks here,
// then shrinks the picture and stores it in Supabase, and the recipe no longer depends on the original site.
// GET /api/image?url=...  with the user's Supabase access token as a Bearer token  ->  the image bytes.
import { createClient } from "@supabase/supabase-js";
import { messageFr } from "@/lib/erreur";
import { safeFetch } from "@/lib/safeFetch";
import { SUPABASE_KEY, SUPABASE_URL } from "@/lib/supabase";

export async function GET(request: Request) {
  const token = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return Response.json({ error: "Non connecté." }, { status: 401 });
  const { data, error } = await createClient(SUPABASE_URL, SUPABASE_KEY).auth.getUser(token);
  if (error || !data.user) return Response.json({ error: "Session expirée, reconnectez-vous." }, { status: 401 });

  const url = new URL(request.url).searchParams.get("url") ?? "";
  try {
    const res = await safeFetch(url, { headers: { "User-Agent": "Mozilla/5.0", Accept: "image/*" } }, 8_000_000);
    const type = res.headers.get("content-type") ?? "";
    if (!res.ok || !/^image\/(jpeg|png|webp|gif|avif)/.test(type)) return Response.json({ error: "Image introuvable." }, { status: 422 });
    return new Response(await res.arrayBuffer(), { headers: { "Content-Type": type, "Cache-Control": "no-store" } });
  } catch (e) {
    return Response.json({ error: messageFr(e) }, { status: 422 });
  }
}
