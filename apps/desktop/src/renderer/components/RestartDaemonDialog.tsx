import { useRef } from "react";
import { useT } from "../i18n/provider.js";
import { Button } from "../ui/button.js";
import { useDismissTransition } from "../lib/useDismissTransition.js";
import { useModalKeys } from "../lib/useModalKeys.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { dialogOverlayClass, dialogPanelClass } from "../ui/dialog.js";

export function RestartDaemonDialog({ onConfirm, onClose, busy }: { onConfirm: () => void; onClose: () => void; busy?: boolean }): JSX.Element {
  const t = useT();
  // Symmetric enter/exit motion + Escape/⌘↵ + focus trap + dialog ARIA. Mounted via {restartConfirm && …},
  // so useDismissTransition/useFocusTrap state resets per open.
  const panelRef = useRef<HTMLDivElement>(null);
  const { closing, dismiss } = useDismissTransition(onClose);
  useModalKeys({ escape: "close", onEscape: dismiss, onSubmit: onConfirm });
  useFocusTrap(panelRef);
  return (
    <div
      className={dialogOverlayClass({ closing })}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("restartDaemonDialog.title")}
        className={dialogPanelClass({ size: "sm", closing, className: "flex flex-col gap-3" })}
      >
        <div className="text-title font-medium">{t("restartDaemonDialog.title")}</div>
        <p className="text-ui leading-relaxed text-muted">{t("restartDaemonDialog.body")}</p>
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="outline" size="sm" autoFocus onClick={dismiss}>{t("common.cancel")}</Button>
          <Button variant="primary" size="sm" onClick={onConfirm} loading={busy}>{t("restartDaemonDialog.confirm")}</Button>
        </div>
      </div>
    </div>
  );
}
