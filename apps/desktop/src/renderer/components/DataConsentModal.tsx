import { useId, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { useT } from "../i18n/provider.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";

interface DataConsentModalProps {
  onAccept: () => Promise<unknown>; // caller returns the settings.set promise so failures surface here (audit #7)
}

// Visibility (daemon up && settings loaded && hasAcceptedDataNotice !== "1") is decided by the App.tsx mount
// site (mirroring OnboardingModal) so the panel exists on first mount and useFocusTrap's effect actually attaches.
export function DataConsentModal({ onAccept }: DataConsentModalProps): JSX.Element {
  const t = useT();
  const titleId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(false);
  // Blocking Accept-only gate: no useModalKeys here on purpose, so Escape stays a no-op (audit #26).
  useFocusTrap(panelRef);
  const accept = async (): Promise<void> => {
    if (busy) return;
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
