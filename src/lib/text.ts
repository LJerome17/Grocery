// Text helpers shared by the parsers.

/** Lowercase and strip accents while keeping the string length unchanged (1 char in, 1 char out). */
export function fold(s: string): string {
  let out = "";
  for (const ch of s.toLowerCase()) {
    const base = ch.normalize("NFD")[0];
    out += base.length === 1 ? base : ch;
  }
  return out;
}

/** Key used to compare ingredient names: folded, punctuation removed, single spaces. */
export function nameKey(s: string): string {
  return fold(s)
    .replace(/['’`]/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function decodeEntities(s: string): string {
  return s
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/(^|\s)u0026(\s|$)/g, "$1&$2") // "&" whose backslash was lost upstream
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#8217;|&rsquo;/g, "’")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

export function cleanSpaces(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
