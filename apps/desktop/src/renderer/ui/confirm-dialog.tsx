import { useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "../i18n/provider.js";
import { useDismissTransition } from "../lib/useDismissTransition.js";
import { useModalKeys } from "../lib/useModalKeys.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";
import { Button } from "./button.js";
import { dialogOverlayClass, dialogPanelClass } from "./dialog.js";

// Shared confirm dialog (audit #73) — extracted from the ~6 hand-rolled copies that had each drifted a little
// (panel width/padding, title size, button markup): Sessions' DeleteConfirm, RepoTree's WorkerDeleteConfirm +
// RepoRemoveConfirm, GitChanges' RevertConfirm, FileTree's TrashConfirm, AutomationPage's AutomationDeleteConfirm,
// and TabCloseConfirm. Panel chrome comes from the shared dialog shell (ui/dialog.tsx, size sm) instead of varying
// per call site. Structure/behavior is unchanged from those originals: overlay + panel, useModalKeys (Escape
// cancels, Cmd/Ctrl+Enter confirms) + useFocusTrap, autofocused Cancel (safe default), symmetric enter/exit via
// useDismissTransition. createPortal to document.body — same as the just-fixed TabCloseConfirm — so a call site
// nested inside a transformed ancestor (e.g. a dockview pane) never clips a `position:fixed` overlay.
//
// The confirm rule (audit #103): an action that can't be undone (delete, revert, discard, secret removal, token
// rotation) goes through this dialog; a light action that can be undone runs at once and offers Undo in a toast
// (`toast.info(text, { label, onClick })`, e.g. Reset layout). No same-button double clicks, no unguarded deletes.
// `secondary` adds a middle action for three-way prompts (Settings' unsaved changes: Cancel / Discard / Save).
export function ConfirmDialog({
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
  variant = "default",
  secondary,
}: {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  variant?: "danger" | "default";
  secondary?: { label: string; onClick: () => void };
}): JSX.Element {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const { closing, dismiss } = useDismissTransition(onCancel);
  // One choice per dialog: the panel stays mounted ~140ms for its exit, and a double click or Cmd+Enter + click must
  // not run a non-idempotent action (restore, delete, token rotation) twice. Confirm and secondary share the guard.
  const chosen = useRef(false);
  const choose = (action: () => void): void => {
    if (chosen.current) return;
    chosen.current = true;
    action();
    dismiss();
  };
  const confirmAndClose = (): void => choose(onConfirm);
  useModalKeys({ escape: "close", onEscape: dismiss, onSubmit: confirmAndClose });
  useFocusTrap(panelRef);
  return createPortal(
    <div className={dialogOverlayClass({ closing, z: "z-[110]" })}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={title} className={dialogPanelClass({ size: "sm", closing, className: closing ? "pointer-events-none" : undefined })}>
        <div className="mb-1.5 text-title font-medium">{title}</div>
        <p className="text-ui leading-relaxed text-muted">{body}</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" size="sm" autoFocus onClick={dismiss}>{t("common.cancel")}</Button>
          {secondary && <Button variant="outline" size="sm" onClick={() => choose(secondary.onClick)}>{secondary.label}</Button>}
          <Button variant={variant === "danger" ? "dangerSolid" : "primary"} size="sm" onClick={confirmAndClose}>{confirmLabel}</Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
