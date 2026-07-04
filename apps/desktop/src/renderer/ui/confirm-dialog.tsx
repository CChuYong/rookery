import { useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/provider.js";
import { useDismissTransition } from "../lib/useDismissTransition.js";
import { useModalKeys } from "../lib/useModalKeys.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { Button } from "./button.js";

// Shared confirm dialog (audit #73) — extracted from the ~6 hand-rolled copies that had each drifted a little
// (panel width/padding, title size, button markup): Sessions' DeleteConfirm, RepoTree's WorkerDeleteConfirm +
// RepoRemoveConfirm, GitChanges' RevertConfirm, FileTree's TrashConfirm, AutomationPage's AutomationDeleteConfirm,
// and TabCloseConfirm. Panel padding/title size are now fixed (w-[360px] p-5, 14px title) instead of varying
// per call site. Structure/behavior is unchanged from those originals: overlay + panel, useModalKeys (Escape
// cancels, Cmd/Ctrl+Enter confirms) + useFocusTrap, autofocused Cancel (safe default), symmetric enter/exit via
// useDismissTransition. createPortal to document.body — same as the just-fixed TabCloseConfirm — so a call site
// nested inside a transformed ancestor (e.g. a dockview pane) never clips a `position:fixed` overlay.
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  variant = "default",
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: "danger" | "default";
}): JSX.Element {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const { closing, dismiss } = useDismissTransition(onCancel);
  const confirmAndClose = (): void => { onConfirm(); dismiss(); };
  useModalKeys(dismiss, confirmAndClose);
  useFocusTrap(panelRef);
  return createPortal(
    <div className={cn("fixed inset-0 z-[110] flex items-center justify-center bg-black/55 backdrop-blur-sm", closing ? "motion-safe:animate-[overlay-out_130ms_ease-in]" : "motion-safe:animate-[overlay-in_140ms_ease-out]")}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={title} className={cn("w-[360px] rounded-xl border border-line bg-surface p-5", closing ? "motion-safe:animate-[dialog-out_140ms_ease-in]" : "motion-safe:animate-[dialog-in_160ms_ease-out]")}>
        <div className="mb-1.5 text-[14px] font-semibold">{title}</div>
        <p className="text-[12.5px] leading-relaxed text-muted">{body}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" autoFocus onClick={dismiss}>{t("common.cancel")}</Button>
          <Button variant={variant === "danger" ? "dangerSolid" : "primary"} size="sm" onClick={confirmAndClose}>{confirmLabel}</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
