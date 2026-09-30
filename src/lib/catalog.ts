// Match free-text ingredient names ("Red Onion, finely sliced") to catalogue entries ("Oignon rouge").

import { nameKey } from "./text";

export type AliasIndex = {
  exact: Map<string, string>;
  /** [alias, ingredient id], longest first. */
  all: [string, string][];
};

export function buildAliasIndex(entries: { id: string; aliases: string[] }[]): AliasIndex {
  const exact = new Map<string, string>();
  for (const e of entries) for (const a of e.aliases) exact.set(nameKey(a), e.id);
  const all = [...exact.entries()].sort((a, b) => b[0].length - a[0].length);
  return { exact, all };
}

/**
 * Exact alias first; otherwise the alias that appears earliest in the name as whole words,
 * ties broken by length ("oignon rouge haché" -> "oignon rouge", "sirop d'érable ou de miel" -> "sirop d'érable").
 */
export function matchIngredient(name: string, index: AliasIndex): string | null {
  const key = nameKey(name);
  if (!key) return null;
  const hit = index.exact.get(key) ?? index.exact.get(key.replace(/s$/, ""));
  if (hit) return hit;

  const padded = ` ${key} `;
  let best: { pos: number; len: number; id: string } | null = null;
  for (const [alias, id] of index.all) {
    const pos = padded.indexOf(` ${alias} `);
    if (pos < 0) continue;
    if (!best || pos < best.pos || (pos === best.pos && alias.length > best.len)) best = { pos, len: alias.length, id };
  }
  return best?.id ?? null;
}
