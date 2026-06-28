import { useEffect, useState } from "react";
import { Button } from "../ui/button.js";
import { useT } from "../i18n/provider.js";
import type { UpdateStatus } from "../types/rookery.js";

// Settings "About" section: current version + manual update check + status (checking/downloading/ready → restart).
// Auto-update otherwise runs silently at launch; this surfaces it and lets the user trigger it on demand.
export function UpdateSettings() {
  const t = useT();
  const [version, setVersion] = useState("");
  const [st, setSt] = useState<UpdateStatus | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const r = window.rookery;
    if (!r?.getVersion) return; // bridge absent (outside Electron / tests) → render gracefully
    void r.getVersion().then(setVersion);
    return r.update?.onStatus(setSt);
  }, []);

  const check = async (): Promise<void> => {
    if (!window.rookery?.update) return;
    setBusy(true);
    try { await window.rookery.update.check(); } finally { setBusy(false); }
  };

  const statusText = ((): string | null => {
    if (!st) return null;
    switch (st.status) {
      case "checking": return t("settings.updChecking");
      case "up-to-date": return t("settings.updUpToDate");
      case "available": return t("settings.updAvailable", { version: st.version ?? "" });
      case "downloading": return t("settings.updDownloading", { percent: st.percent ?? 0 });
      case "ready": return t("settings.updReady", { version: st.version ?? "" });
      case "error": return `${t("settings.updError")}${st.message ? ` — ${st.message}` : ""}`;
      case "dev": return t("settings.updDev");
      default: return null;
    }
  })();

  const working = busy || st?.status === "checking" || st?.status === "downloading";
  return (
    <section className="mt-8">
      <h2 className="text-[13px] font-semibold">{t("settings.about")}</h2>
      <p className="mt-1 text-[11px] leading-relaxed text-muted">{t("settings.aboutDesc")}</p>
      <div className="mt-3 flex items-center gap-3 rounded-[var(--radius)] border border-line bg-ink/40 px-3 py-2.5">
        <span className="text-[12px] text-fg-dim">{t("settings.currentVersion")}</span>
        <span className="font-mono text-[12px] text-fg">v{version || "…"}</span>
        <div className="ml-auto">
          {st?.status === "ready" ? (
            <Button variant="primary" size="sm" onClick={() => window.rookery.update?.install()}>{t("settings.updRestart")}</Button>
          ) : (
            <Button variant="outline" size="sm" disabled={working} onClick={check}>{t("settings.checkUpdate")}</Button>
          )}
        </div>
      </div>
      {statusText && <p className="mt-2 text-[11px] text-muted">{statusText}</p>}
    </section>
  );
}
