import { useT } from "../i18n/provider.js";
import { ConfirmDialog } from "../ui/confirm-dialog.js";

// Shared dirty-tab close confirm (audit #44) — the ONE dialog used by BOTH the
// legacy TabBar's X and the dockview RookeryTab's close, so unsaved-edit loss
// is guarded identically no matter which tab chrome is active. A thin wrapper
// around the shared ConfirmDialog (audit #73) — it already portals to
// document.body (the reason this component needed to, in the first place:
// RookeryTab renders it from inside a dockview tab header whose ancestor
// carries a CSS transform, which would trap `position: fixed` to that header —
// the dialog would render as a bar in the top tab strip instead of a centered
// overlay, audit #44 final-review clipping).
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
  return (
    <ConfirmDialog
      title={t("tabBar.unsavedTitle")}
      body={t("tabBar.unsavedBody", { name: tabTitle })}
      confirmLabel={t("tabBar.discardClose")}
      variant="danger"
      onConfirm={onDiscard}
      onCancel={onCancel}
    />
  );
}
