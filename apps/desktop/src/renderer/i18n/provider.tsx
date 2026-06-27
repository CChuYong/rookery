import { createContext, useContext, useEffect, useMemo } from "react";
import type { ReactNode } from "react";
import { catalogs } from "./catalog.js";
import { translate } from "./core.js";
import { resolveLocale } from "./resolve.js";
import type { Locale, TParams } from "./types.js";
import { usePrefsStore } from "../store/prefs.js";

export type TFunc = (key: string, params?: TParams) => string;
interface I18nCtx { locale: Locale; t: TFunc; }

const Ctx = createContext<I18nCtx | null>(null);
// Fall back to ko when no provider is present — protects existing tests that assert on Korean.
const FALLBACK: I18nCtx = { locale: "ko", t: (k, p) => translate(catalogs.ko, k, p) };

export function I18nProvider({ systemLocale, children }: { systemLocale: string; children: ReactNode }): JSX.Element {
  const pref = usePrefsStore((s) => s.localePref);
  const value = useMemo<I18nCtx>(() => {
    const locale = resolveLocale(pref, systemLocale);
    const catalog = catalogs[locale];
    return { locale, t: (k, p) => translate(catalog, k, p) };
  }, [pref, systemLocale]);
  // Tag the document language (drives CSS :lang(), font selection, hyphenation) + push the active locale to main
  // (sync main-side i18n, e.g. error messages). No-op if the bridge is absent.
  useEffect(() => {
    document.documentElement.lang = value.locale;
    (window as unknown as { rookery?: { system?: { setLocale?: (l: string) => void } } }).rookery?.system?.setLocale?.(value.locale);
  }, [value.locale]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useT(): TFunc { return (useContext(Ctx) ?? FALLBACK).t; }
export function useLocale(): Locale { return (useContext(Ctx) ?? FALLBACK).locale; }
