"use client";

import { useApp } from "./AppProvider";

/** Français / English before a household exists (then it is a household setting, in Réglages). */
export function LangPicker() {
  const { lang, chooseLang } = useApp();
  return (
    <div className="flex justify-center gap-2">
      <button type="button" className={lang === "fr" ? "chip-on" : "chip"} onClick={() => chooseLang("fr")}>
        Français
      </button>
      <button type="button" className={lang === "en" ? "chip-on" : "chip"} onClick={() => chooseLang("en")}>
        English
      </button>
    </div>
  );
}
