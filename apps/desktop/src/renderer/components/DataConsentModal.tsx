import { useId, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useT } from "../i18n/provider.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import type { SettingsValues } from "@daemon/core/settings.js";

interface DataConsentModalProps {
  settings: SettingsValues | null;
  daemon: "up" | "down" | "starting";
  onAccept: () => Promise<unknown>; // caller returns the settings.set promise so failures surface here (audit #7)
}

export function DataConsentModal({ settings, daemon, onAccept }: DataConsentModalProps): JSX.Element | null {
  const t = useT();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  // Blocking Accept-only gate: no useModalKeys here on purpose, so Escape stays a no-op (audit #26).
  useFocusTrap(panelRef);
  // Only show when connected AND settings loaded AND not accepted
  if (daemon !== "up" || settings === null || settings.hasAcceptedDataNotice === "1") {
    return null;
  }
  const accept = async (): Promise<void> => {
    setBusy(true);
    setErr(false);
    try {
      await onAccept();
      // On success, hasAcceptedDataNotice flips to "1" and the parent stops rendering this modal — no reset needed.
    } catch {
      setErr(true);
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-surface border border-line rounded-xl p-8 max-w-md w-full mx-4 shadow-2xl"
      >
        <h2 id={titleId} className="text-lg font-semibold mb-4">{t("dataConsent.title")}</h2>
        <p className="text-sm text-muted mb-6">{t("dataConsent.body")}</p>
        <button
          autoFocus
          disabled={busy}
          aria-busy={busy || undefined}
          className="w-full flex items-center justify-center gap-1.5 rounded-lg bg-accent text-white py-2 px-4 font-medium hover:bg-accent/90 transition-colors disabled:opacity-70"
          onClick={() => void accept()}
        >
          {busy && <Loader2 size={14} className="animate-spin motion-reduce:hidden" aria-hidden />}
          {t("dataConsent.accept")}
        </button>
        {err && <p className="mt-2 text-[12px] text-fail">{t("dataConsent.saveFailed")}</p>}
      </div>
    </div>
  );
}
