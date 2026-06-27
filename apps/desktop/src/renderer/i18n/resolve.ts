import type { Locale, LocalePref } from "./types.js";

export function resolveLocale(pref: LocalePref, systemLocale: string): Locale {
  if (pref === "ko" || pref === "en") return pref;
  return systemLocale.toLowerCase().startsWith("ko") ? "ko" : "en";
}
