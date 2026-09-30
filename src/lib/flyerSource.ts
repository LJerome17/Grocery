// Server-side fetch of the Maxi flyer for a postal code (service behind Reebee/Flipp; unofficial).
import type { FlyerItem } from "./flyer";

const BASE = "https://backflipp.wishabi.com/flipp";
const HEADERS = { "User-Agent": "Mozilla/5.0", Accept: "application/json" };

type FlyerSummary = { id: number; merchant?: string; merchant_name?: string; valid_from: string; valid_to: string };

export type Flyer = { id: number; validFrom: string; validTo: string; items: FlyerItem[] };

const cache = new Map<string, { at: number; value: Flyer | null }>();

/** The Maxi flyer valid on `date` (else the most recent one) for a Canadian postal code. */
export async function fetchMaxiFlyer(postalCode: string, date: Date): Promise<Flyer | null> {
  const cp = postalCode.replace(/\s+/g, "").toUpperCase();
  const day = date.toISOString().slice(0, 10);
  const key = `${cp}:${day}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 3600_000) return hit.value;

  const res = await fetch(`${BASE}/flyers?locale=fr-ca&postal_code=${encodeURIComponent(cp)}`, { headers: HEADERS });
  if (!res.ok) throw new Error(`Circulaires indisponibles (HTTP ${res.status}).`);
  const data = (await res.json()) as FlyerSummary[] | { flyers?: FlyerSummary[] };
  const flyers = (Array.isArray(data) ? data : data.flyers ?? []).filter((f) => /^maxi\b/i.test((f.merchant ?? f.merchant_name ?? "").trim()));
  if (!flyers.length) {
    cache.set(key, { at: Date.now(), value: null });
    return null;
  }
  const t = date.getTime();
  const valid = flyers.find((f) => new Date(f.valid_from).getTime() <= t && t <= new Date(f.valid_to).getTime());
  const chosen = valid ?? flyers.sort((a, b) => b.valid_from.localeCompare(a.valid_from))[0];

  const detail = await fetch(`${BASE}/flyers/${chosen.id}?locale=fr-ca`, { headers: HEADERS });
  if (!detail.ok) throw new Error(`Circulaire indisponible (HTTP ${detail.status}).`);
  const d = (await detail.json()) as { items?: FlyerItem[] };
  const value = { id: chosen.id, validFrom: chosen.valid_from.slice(0, 10), validTo: chosen.valid_to.slice(0, 10), items: d.items ?? [] };
  cache.set(key, { at: Date.now(), value });
  return value;
}
