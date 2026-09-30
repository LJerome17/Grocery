// Accounts by username, without email: Supabase needs an address, so a username becomes an internal one
// (never written to, as no email is ever sent). A real email address typed instead is used as is.
import { UserMessage } from "./erreur";
import { tr } from "./i18n";
import { supabase } from "./supabase";

const DOMAIN = "utilisateurs.momo-et-jeje.app";

/** "Jéjé" -> "jeje"; null when it cannot be a username (3 to 30 letters, digits, . _ -). */
export function usernameKey(input: string): string | null {
  const key = input.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, "-");
  return /^[a-z0-9._-]{3,30}$/.test(key) ? key : null;
}

/** Login address for a username or an email. */
export function loginEmail(input: string): string | null {
  if (input.includes("@")) return input.trim();
  const key = usernameKey(input);
  return key && `${key}@${DOMAIN}`;
}

/** What to show for a signed-in account: the username as typed ("Jérôme"), else its login key, else the real email. */
export function accountName(email: string | undefined, typed?: unknown): string {
  if (typeof typed === "string" && typed) return typed;
  return email?.endsWith(`@${DOMAIN}`) ? email.slice(0, -DOMAIN.length - 1) : email ?? "";
}

export const usernameRule = () => tr("3 à 30 caractères : lettres, chiffres, point, tiret ou trait de soulignement.", "3 to 30 characters: letters, digits, dot, dash or underscore.");

/** Attach a username (or email) and a password to the current anonymous access; throws a French message. */
export async function protectAccess(input: string, password: string): Promise<void> {
  const email = loginEmail(input);
  if (!email) throw new UserMessage(tr(`Nom d'utilisateur invalide (${usernameRule()})`, `Invalid username (${usernameRule()})`));
  if (password.length < 6) throw new UserMessage(tr("Le mot de passe doit contenir au moins 6 caractères.", "The password must have at least 6 characters."));
  const sb = supabase();
  await setLogin(input, email);
  const b = await sb.auth.updateUser({ password });
  if (b.error) throw b.error;
}

// A username cannot be changed afterwards: Supabase would email the (internal) address first.

async function setLogin(input: string, email: string) {
  const { error } = await supabase().auth.updateUser({ email, data: { username: input.includes("@") ? null : input.trim() } });
  if (error) throw /already|exists/i.test(error.message) ? new UserMessage(tr("Ce nom d'utilisateur est déjà pris.", "This username is taken.")) : error;
}
