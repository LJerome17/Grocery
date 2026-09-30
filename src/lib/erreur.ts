// Error messages shown to people are always in French; Supabase and the browser speak English.

const KNOWN: [RegExp, string][] = [
  [/invalid login credentials/i, "Nom d'utilisateur ou mot de passe incorrect."],
  [/already (been )?registered|already exists/i, "Ce nom d'utilisateur est déjà pris : utilisez « Se connecter »."],
  [/password should be at least/i, "Le mot de passe doit contenir au moins 6 caractères."],
  [/invalid format|valid email|email address .* invalid/i, "Adresse courriel invalide."],
  [/signups? not allowed|anonymous sign-ins are disabled/i, "Les inscriptions sont fermées pour l'instant."],
  [/email logins are disabled/i, "La connexion avec mot de passe n'est pas encore activée."],
  [/rate limit|too many requests/i, "Trop de tentatives : réessayez dans quelques minutes."],
  [/jwt expired|invalid jwt|not authenticated|session/i, "Session expirée : rechargez la page."],
  [/failed to fetch|networkerror|network request failed|fetch failed|load failed/i, "Pas de connexion Internet, ou le serveur ne répond pas."],
  [/row-level security|permission denied|violates row-level/i, "Action non autorisée pour ce foyer."],
  [/duplicate key/i, "Cet élément existe déjà."],
  [/payload too large|exceeded the maximum allowed size/i, "Fichier trop volumineux."],
];

/** French message for any error; messages already written in French (ours) are kept. */
export function messageFr(e: unknown): string {
  const raw = e instanceof Error ? e.message : typeof e === "object" && e && "message" in e ? String((e as { message: unknown }).message) : String(e);
  for (const [re, fr] of KNOWN) if (re.test(raw)) return fr;
  if (/[àâçéèêëîïôûù]|^(Aucun|Le site|Lien|Session|Code|Non connecté|Nom d|Trop de|Fichier|Image)/i.test(raw)) return raw;
  console.error(e);
  return "Une erreur est survenue. Réessayez dans un instant.";
}
