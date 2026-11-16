import { useEffect, useState } from "react";
import { useWsStore } from "../store/workspace.js";
import { TabCloseConfirm } from "../components/TabCloseConfirm.js";
import { onCloseTabShortcut } from "./close-tab-dispatch.js";

// Cmd/Ctrl+W (forwarded by main, audit #82, routed by close-tab-dispatch) closes the page's active editor tab. An
// unsaved file tab goes through the same TabCloseConfirm as its × button; the conversation tab is never closed. The
// handler always takes the key on a workspace page (the pinned conversation tab is a deliberate no-op, not a window
// close). Modal layers and the Windows/Linux terminal delete-word are handled by the dispatcher before this runs.
// Returns the confirm dialog to render.
export function useCloseTabShortcut(pageKey: string | null): JSX.Element | null {
  const [confirming, setConfirming] = useState<{ id: string; title: string } | null>(null);
  useEffect(() => {
    if (!pageKey) return;
    return onCloseTabShortcut(() => {
      const page = useWsStore.getState().byPage[pageKey];
      const tab = page?.tabs.find((tb) => tb.id === page.activeTabId);
      if (!tab || tab.kind === "agent") return true;
      if (tab.kind === "file" && tab.dirty) setConfirming({ id: tab.id, title: tab.title });
      else useWsStore.getState().closeTabs_(pageKey, [tab.id]);
      return true;
    });
  }, [pageKey]);
  if (!confirming || !pageKey) return null;
  return (
    <TabCloseConfirm
      tabTitle={confirming.title}
      onDiscard={() => { useWsStore.getState().closeTabs_(pageKey, [confirming.id]); setConfirming(null); }}
      onCancel={() => setConfirming(null)}
    />
  );
}
