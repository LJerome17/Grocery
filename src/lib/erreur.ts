// Error messages shown to people, in the household's language; Supabase and the browser speak English,
// the server routes answer in French.
import { lang, tr } from "./i18n";

const KNOWN: [RegExp, string, string][] = [
  [/invalid login credentials/i, "Nom d'utilisateur ou mot de passe incorrect.", "Wrong username or password."],
  [/already (been )?registered|already exists/i, "Ce nom d'utilisateur est déjà pris : utilisez « Se connecter ».", "This username is taken: use “Sign in”."],
  [/password should be at least/i, "Le mot de passe doit contenir au moins 6 caractères.", "The password must have at least 6 characters."],
  [/invalid format|valid email|email address .* invalid/i, "Adresse courriel invalide.", "Invalid email address."],
  [/signups? not allowed|anonymous sign-ins are disabled/i, "Les inscriptions sont fermées pour l'instant.", "Sign-ups are closed for now."],
  [/email logins are disabled/i, "La connexion avec mot de passe n'est pas encore activée.", "Password sign-in is not enabled yet."],
  [/rate limit|too many requests/i, "Trop de tentatives : réessayez dans quelques minutes.", "Too many attempts: try again in a few minutes."],
  [/jwt expired|invalid jwt|not authenticated|session/i, "Session expirée : rechargez la page.", "Session expired: reload the page."],
  [/failed to fetch|networkerror|network request failed|fetch failed|load failed/i, "Pas de connexion Internet, ou le serveur ne répond pas.", "No Internet connection, or the server is not answering."],
  [/row-level security|permission denied|violates row-level/i, "Action non autorisée pour ce foyer.", "Not allowed for this household."],
  [/duplicate key/i, "Cet élément existe déjà.", "This already exists."],
  [/payload too large|exceeded the maximum allowed size/i, "Fichier trop volumineux.", "File too large."],
];

/** French messages written by the server routes and shared code, in English. */
const FRENCH_EN: [RegExp, string][] = [
  [/^Le site a refusé la lecture \(HTTP (\d+)\)/, "The site refused to be read (HTTP $1). Use “Paste the text” instead."],
  [/^Lien invalide : seules/, "Invalid link: only web addresses are accepted."],
  [/^Lien invalide/, "Invalid link."],
  [/^Lien ou texte manquant/, "Link or text missing."],
  [/^Trop de redirections/, "Too many redirects."],
  [/^Fichier trop volumineux/, "File too large."],
  [/^Image introuvable/, "Picture not found."],
  [/^Non connecté/, "Not signed in."],
  [/^Session expirée/, "Session expired: sign in again."],
  [/^Aucun ingrédient trouvé/, "No ingredients found. Try pasting the recipe text."],
];

/** An error whose message is already written for people (with tr()): shown as is. */
export class UserMessage extends Error {}

/** Message for any error in the household's language; our own messages are kept (server ones translated). */
export function messageFr(e: unknown): string {
  if (e instanceof UserMessage) return e.message;
  const raw = e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
  for (const [re, fr, en] of KNOWN) if (re.test(raw)) return tr(fr, en);
  if (lang() === "en") {
    for (const [re, en] of FRENCH_EN) {
      const m = raw.match(re);
      if (m) return en.replace("$1", m[1] ?? "");
    }
  } else if (/[àâçéèêëîïôûù]|^(Aucun|Le site|Lien|Session|Code|Non connecté|Nom d|Trop de|Fichier|Image)/i.test(raw)) return raw;
  console.error(e);
  return tr("Une erreur est survenue. Réessayez dans un instant.", "Something went wrong. Try again in a moment.");
}
