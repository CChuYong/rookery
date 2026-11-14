import "./monaco-setup.js";
// The UI face is the system font (SF Pro on macOS); Geist Mono is the bundled fallback behind SF Mono.
import "@fontsource-variable/geist-mono";
// Korean face — Pretendard (OFL) sits in --font-sans as the Hangul fallback for platforms whose system UI font lacks it.
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
