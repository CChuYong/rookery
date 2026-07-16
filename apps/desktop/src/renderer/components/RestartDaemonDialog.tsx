import { useRef } from "react";
import { useT } from "../i18n/provider.js";
import { Button } from "../ui/button.js";
import { useDismissTransition } from "../lib/useDismissTransition.js";
import { useModalKeys } from "../lib/useModalKeys.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { cn } from "../lib/cn.js";

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
      className={cn("fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4 backdrop-blur-sm", closing ? "motion-safe:animate-[overlay-out_130ms_ease-in]" : "motion-safe:animate-[overlay-in_160ms_ease-out]")}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("restartDaemonDialog.title")}
        className={cn("flex w-full max-w-md flex-col gap-3 rounded-xl border border-line bg-surface p-5", closing ? "motion-safe:animate-[dialog-out_140ms_ease-in]" : "motion-safe:animate-[dialog-in_180ms_ease-out]")}
      >
        <div className="text-[14px] font-semibold">{t("restartDaemonDialog.title")}</div>
        <p className="text-[12.5px] leading-relaxed text-muted">{t("restartDaemonDialog.body")}</p>
        <div className="mt-1 flex justify-end gap-2">
          <Button variant="outline" size="sm" autoFocus onClick={dismiss}>{t("common.cancel")}</Button>
          <Button variant="primary" size="sm" onClick={onConfirm} loading={busy}>{t("restartDaemonDialog.confirm")}</Button>
        </div>
      </div>
    </div>
  );
}
