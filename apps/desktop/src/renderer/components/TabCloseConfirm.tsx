import { useRef } from "react";
import { cn } from "../lib/cn.js";
import { useT } from "../i18n/provider.js";
import { useDismissTransition } from "../lib/useDismissTransition.js";
import { useModalKeys } from "../lib/useModalKeys.js";
import { useFocusTrap } from "../lib/useFocusTrap.js";

// Shared dirty-tab close confirm (audit #44) — the ONE dialog used by BOTH the
// legacy TabBar's X and the dockview RookeryTab's close, so unsaved-edit loss
// is guarded identically no matter which tab chrome is active. Structure copied
// from the quick-wins AutomationDeleteConfirm/RepoRemoveConfirm (overlay + panel
// + useModalKeys/useFocusTrap + autofocused Cancel).
//
// Discard-only (no Save button): Monaco's save command (`MonacoEditor.tsx`) is
// local to the mounted editor instance with no tab-id-addressable hook exposed
// to callers outside that component, so there's nothing this dialog could
// invoke to save a *different* tab's buffer. This matches the existing tone
// precedent for buffer loss in this app — the external-change banner in
// MonacoEditor.tsx also offers only an explicit "Reload (discard edits)"
// action, not a save option.
export function TabCloseConfirm({ tabTitle, onDiscard, onCancel }: { tabTitle: string; onDiscard: () => void; onCancel: () => void }): JSX.Element {
  const t = useT();
  const panelRef = useRef<HTMLDivElement>(null);
  const { closing, dismiss } = useDismissTransition(onCancel);
  const discardAndClose = (): void => { onDiscard(); dismiss(); };
  useModalKeys(dismiss, discardAndClose);
  useFocusTrap(panelRef);
  return (
    <div className={cn("fixed inset-0 z-[110] flex items-center justify-center bg-black/55 backdrop-blur-sm", closing ? "motion-safe:animate-[overlay-out_130ms_ease-in]" : "motion-safe:animate-[overlay-in_140ms_ease-out]")}>
      <div ref={panelRef} role="dialog" aria-modal="true" aria-label={t("tabBar.unsavedTitle")} className={cn("w-[360px] rounded-xl border border-line bg-surface p-5", closing ? "motion-safe:animate-[dialog-out_140ms_ease-in]" : "motion-safe:animate-[dialog-in_160ms_ease-out]")}>
        <div className="mb-1.5 text-[14px] font-semibold">{t("tabBar.unsavedTitle")}</div>
        <p className="text-[12.5px] leading-relaxed text-muted">{t("tabBar.unsavedBody", { name: tabTitle })}</p>
        <div className="mt-4 flex justify-end gap-2">
          <button autoFocus onClick={dismiss} className="rounded-lg border border-line px-3 py-1.5 text-[12.5px] text-muted hover:bg-raised hover:text-fg-dim">{t("common.cancel")}</button>
          <button onClick={discardAndClose} className="rounded-lg bg-fail/90 px-3 py-1.5 text-[12.5px] font-medium text-fg hover:bg-fail">{t("tabBar.discardClose")}</button>
        </div>
      </div>
    </div>
  );
}
