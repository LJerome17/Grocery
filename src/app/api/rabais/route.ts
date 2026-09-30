// Maxi flyer deals for a postal code and a date, matched to the global ingredient catalogue.
// GET /api/rabais?cp=H4C0B8&date=2026-10-05  ->  { validFrom, validTo, deals: Deal[] } (deals: [] when unavailable)
import catalog from "../../../../data/catalog.json";
import { toDeals } from "@/lib/flyer";
import { fetchMaxiFlyer } from "@/lib/flyerSource";
import { nameKey } from "@/lib/text";

const aliases = new Map<string, string>();
for (const i of catalog.ingredients) {
  if (i.aisle === "aucun") continue; // water is never bought
  for (const a of i.aliases) aliases.set(nameKey(a), i.name);
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const cp = (url.searchParams.get("cp") ?? "").replace(/\s+/g, "").toUpperCase();
  if (!/^[A-Z]\d[A-Z]\d[A-Z]\d$/.test(cp)) return Response.json({ error: "Code postal invalide." }, { status: 400 });
  const date = new Date(`${url.searchParams.get("date") ?? new Date().toISOString().slice(0, 10)}T12:00:00`);
  try {
    const flyer = await fetchMaxiFlyer(cp, date);
    if (!flyer) return Response.json({ validFrom: null, validTo: null, deals: [] });
    return Response.json(
      { validFrom: flyer.validFrom, validTo: flyer.validTo, deals: toDeals(flyer.items, aliases, "Maxi") },
      { headers: { "Cache-Control": "public, s-maxage=3600" } },
    );
  } catch {
    // The flyer source is unofficial: when it fails, the app simply shows no deals.
    return Response.json({ validFrom: null, validTo: null, deals: [], unavailable: true });
  }
}
