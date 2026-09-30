// Weekly flyer deals (Maxi) matched to the ingredient catalogue, without AI.
// Flyer data comes from the service behind Reebee/Flipp (unofficial, may change: the app keeps working without it).

import { nameKey } from "./text";

export type FlyerItem = { name: string; price: string | null; valid_from: string; valid_to: string; discount: number | null };

export type Deal = {
  /** Catalogue ingredient name (global catalogue). */
  ingredient: string;
  /** French name of the flyer item, as printed. */
  item: string;
  price: number | null;
  validFrom: string;
  validTo: string;
  store: string;
};

/** Not food: never matched even if a word looks like an ingredient ("pains de savon"). */
const NOT_FOOD = /\b(savon|shampo|dentifrice|nettoyant|detergent|lessive|couches|litiere|nourriture (seche |humide )?pour (chat|chien)|pour chats?|pour chiens?|assainisseur|papier|essuie|mouchoirs|rasoir|deodorant|vitamine|preparation pour nourrissons|javel|petillante)\b/;
/** Processed versions of an ingredient that must not count as the ingredient itself. */
const PROCESSED = /\b(superfries|frites|au chocolat|evapore|condense|enrobes?|pour pizza|a fondue)\b/;
/** Leading words skipped before the product name ("GROS AVOCATS"). */
const LEADING = /^(gros|grosse|grosses|petits?|petites?|mini|bebes?|bio|biologiques?|frais|fraiches?|jumbo|extra|nouvelles?|entiers?|entieres?)\s+/;

/**
 * Catalogue ingredients an item is about. The ingredient must START the product name (after a size adjective),
 * so "purée de pommes de terre" is not potatoes; "CAROTTES OU OIGNONS JAUNES" gives both.
 */
export function matchFlyerItem(name: string, aliases: Map<string, string>): string[] {
  const french = name.split(" | ")[0];
  const main = nameKey(french.split(",")[0].replace(/[®™]/g, ""));
  if (!main || NOT_FOOD.test(main)) return [];
  const found = new Set<string>();
  // Accents matter here: "PÂTÉS" (terrine) is not "PÂTES" (pasta), but both fold to "pates".
  const originals = french.split(",")[0].split(/\s+OU\s+/i).map((s) => s.trim());
  main.split(/\s+ou\s+/).forEach((raw, n) => {
    const firstWord = (originals[n] ?? "").split(/\s+/)[0].toUpperCase();
    if (PROCESSED.test(raw) || /^P[ÂA]TÉS?$/.test(firstWord)) return;
    let segment = raw;
    for (let k = 0; k < 2 && LEADING.test(segment); k++) segment = segment.replace(LEADING, "");
    // Longest alias that starts the segment on a word boundary.
    let best: { alias: string; id: string } | null = null;
    for (const [alias, id] of aliases) {
      if ((segment === alias || segment.startsWith(`${alias} `)) && (!best || alias.length > best.alias.length)) best = { alias, id };
    }
    if (best) found.add(best.id);
  });
  return [...found];
}

export function toDeals(items: FlyerItem[], aliases: Map<string, string>, store: string): Deal[] {
  const deals: Deal[] = [];
  for (const it of items) {
    const price = it.price && !Number.isNaN(Number(it.price)) ? Number(it.price) : null;
    for (const ingredient of matchFlyerItem(it.name, aliases)) {
      deals.push({ ingredient, item: it.name.split(" | ")[0].replace(/,\s*$/, ""), price, validFrom: it.valid_from, validTo: it.valid_to, store });
    }
  }
  return deals;
}

/** "2,48 $" */
export const formatPrice = (p: number | null) => (p === null ? "en rabais" : `${p.toFixed(2).replace(".", ",")} $`);
