"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useApp } from "./AppProvider";

const TABS = [
  { href: "/semaine", label: "Semaine", icon: "📅" },
  { href: "/liste", label: "Épicerie", icon: "🛒" },
  { href: "/recettes", label: "Recettes", icon: "📖" },
  { href: "/reglages", label: "Réglages", icon: "⚙️" },
];

export function BottomNav() {
  const pathname = usePathname();
  const { household } = useApp();
  if (!household) return null;
  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-line bg-card/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
      <ul className="mx-auto flex max-w-xl">
        {TABS.map((t) => {
          const on = pathname.startsWith(t.href);
          return (
            <li key={t.href} className="flex-1">
              <Link
                href={t.href}
                className={`flex flex-col items-center gap-0.5 py-2 text-xs ${on ? "font-semibold text-brand" : "text-muted"}`}
              >
                <span className="text-xl" aria-hidden>
                  {t.icon}
                </span>
                {t.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
