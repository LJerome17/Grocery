// Language of the interface, chosen per household (French by default). Recipes themselves are never translated.
// Every visible text is written as a French/English pair next to where it is used: tr("Semaine", "Week").

export type Lang = "fr" | "en";

let current: Lang = "fr";

/** Set by AppProvider from the household (or the choice made before creating one). */
export function setLang(l: Lang) {
  current = l;
}

export function lang(): Lang {
  return current;
}

/** The text in the current language. */
export function tr(fr: string, en: string): string {
  return current === "en" ? en : fr;
}

/** Locale for dates and numbers. */
export function locale(): string {
  return current === "en" ? "en-CA" : "fr-CA";
}

/** "1 recette" / "2 recettes" in the current language. */
export function plural(n: number, fr: [string, string], en: [string, string]): string {
  const [one, many] = current === "en" ? en : fr;
  return `${n} ${Math.abs(n) > 1 || (current === "en" && n === 0) ? many : one}`;
}
