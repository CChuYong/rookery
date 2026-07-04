import { useId, useRef, useState } from "react";
import { useT } from "../i18n/provider.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { Button } from "../ui/button.js";

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
    // audit #72 — overlay/panel classes aligned with the rest of the modal system (bg-black/55 backdrop-blur-sm +
    // the dialog-in entrance used by RepoModal/RestartDaemonDialog/etc.), and the raw button below is now
    // <Button variant="primary">. No exit animation is wired (no useDismissTransition) — this gate has no
    // dismiss path other than a successful Accept, which unmounts it at the App.tsx mount site.
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 backdrop-blur-sm">
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="bg-surface border border-line rounded-xl p-8 max-w-md w-full mx-4 shadow-2xl motion-safe:animate-[dialog-in_160ms_ease-out]"
      >
        <h2 id={titleId} className="text-lg font-semibold mb-4">{t("dataConsent.title")}</h2>
        <p className="text-sm text-muted mb-6">{t("dataConsent.body")}</p>
        <Button variant="primary" className="w-full" autoFocus loading={busy} onClick={() => void accept()}>
          {t("dataConsent.accept")}
        </Button>
        {err && <p className="mt-2 text-[12px] text-fail">{t("dataConsent.saveFailed")}</p>}
      </div>
    </div>
  );
}
