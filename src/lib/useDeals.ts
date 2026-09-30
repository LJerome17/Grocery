"use client";

import { useEffect, useState } from "react";
import type { Deal } from "./flyer";

export type DealsState = { deals: Deal[]; validFrom: string | null; validTo: string | null; unavailable: boolean; loading: boolean };

/** Maxi deals valid on `date` (YYYY-MM-DD) for the household's postal code. */
export function useDeals(postalCode: string | null | undefined, date: string): DealsState {
  const [state, setState] = useState<DealsState>({ deals: [], validFrom: null, validTo: null, unavailable: false, loading: true });
  useEffect(() => {
    if (!postalCode) return;
    let cancelled = false;
    fetch(`/api/rabais?cp=${encodeURIComponent(postalCode)}&date=${date}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setState({ deals: d.deals ?? [], validFrom: d.validFrom ?? null, validTo: d.validTo ?? null, unavailable: !!d.unavailable || !!d.error, loading: false });
      })
      .catch(() => !cancelled && setState({ deals: [], validFrom: null, validTo: null, unavailable: true, loading: false }));
    return () => {
      cancelled = true;
    };
  }, [postalCode, date]);
  return state;
}

/** Cheapest deal per catalogue ingredient name. */
export function dealsByIngredient(deals: Deal[]): Map<string, Deal> {
  const m = new Map<string, Deal>();
  for (const d of deals) {
    const prev = m.get(d.ingredient);
    if (!prev || (d.price ?? Infinity) < (prev.price ?? Infinity)) m.set(d.ingredient, d);
  }
  return m;
}
