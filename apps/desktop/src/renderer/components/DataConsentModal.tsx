import { useId, useRef, useState } from "react";
import { useT } from "../i18n/provider.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { Button } from "../ui/button.js";
import { dialogOverlayClass, dialogPanelClass } from "../ui/dialog.js";

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
    // audit #72 — overlay/panel classes aligned with the rest of the modal system (bg-scrim +
    // the dialog-in entrance used by RepoModal/RestartDaemonDialog/etc.), and the raw button below is now
    // <Button variant="primary">. No exit animation is wired (no useDismissTransition) — this gate has no
    // dismiss path other than a successful Accept, which unmounts it at the App.tsx mount site.
    <div className={dialogOverlayClass()}>
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={dialogPanelClass({ size: "md" })}
      >
        <h2 id={titleId} className="text-title font-medium text-fg mb-2">{t("dataConsent.title")}</h2>
        <p className="text-body leading-relaxed text-muted mb-5">{t("dataConsent.body")}</p>
        <Button variant="primary" className="w-full" autoFocus loading={busy} onClick={() => void accept()}>
          {t("dataConsent.accept")}
        </Button>
        {err && <p className="mt-2 text-ui text-fail">{t("dataConsent.saveFailed")}</p>}
      </div>
    </div>
  );
}
