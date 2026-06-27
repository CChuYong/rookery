import "./monaco-setup.js";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
// Korean face — Geist ships no Hangul, so Korean UI fell back to a last-resort system font and lost the signature
// typeface. Pretendard (OFL) is designed to harmonize with geometric Latin sans; it sits after Geist in --font-sans
// so Latin glyphs still render in Geist and only Hangul falls through to Pretendard.
import "pretendard/dist/web/variable/pretendardvariable.css";
import "./globals.css";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { I18nProvider } from "./i18n/provider.js";

async function bootstrap(): Promise<void> {
  let systemLocale = "en";
  try { systemLocale = await window.rookery.system.getLocale(); } catch { /* fall back to en */ }
  createRoot(document.getElementById("root")!).render(
    <I18nProvider systemLocale={systemLocale}>
      <App />
    </I18nProvider>,
  );
}
void bootstrap();
