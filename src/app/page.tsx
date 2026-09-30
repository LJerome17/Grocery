"use client";

import { tr } from "@/lib/i18n";

// The route guard in AppProvider sends people to /connexion, /foyer or /semaine.
export default function Home() {
  return <p className="py-20 text-center text-muted">{tr("Chargement…", "Loading…")}</p>;
}
