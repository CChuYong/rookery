/// <reference types="vite/client" />
import type { Catalog, Locale } from "./types.js";

type Mod = { default: Catalog };

function merge(mods: Record<string, Mod>): Catalog {
  const out: Catalog = {};
  for (const m of Object.values(mods)) Object.assign(out, m.default);
  return out;
}

// Auto-collect namespace files — new locales/{ko,en}/*.ts are merged in without editing (zero parallel-work conflicts).
const koMods = import.meta.glob<Mod>("./locales/ko/*.ts", { eager: true });
const enMods = import.meta.glob<Mod>("./locales/en/*.ts", { eager: true });

export const catalogs: Record<Locale, Catalog> = {
  ko: merge(koMods),
  en: merge(enMods),
};
