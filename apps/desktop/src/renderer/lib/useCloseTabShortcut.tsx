import { useEffect, useState } from "react";
import { useWsStore } from "../store/workspace.js";
import { TabCloseConfirm } from "../components/TabCloseConfirm.js";

// Cmd/Ctrl+W (forwarded by main, audit #82) closes the page's active editor tab. An unsaved file tab goes through the
// same TabCloseConfirm as its × button; the conversation tab is never closed. Returns the confirm dialog to render.
export function useCloseTabShortcut(pageKey: string | null): JSX.Element | null {
  const [confirming, setConfirming] = useState<{ id: string; title: string } | null>(null);
  useEffect(() => {
    if (!pageKey) return;
    const off = window.rookery?.win?.onCloseTab?.(() => {
      const page = useWsStore.getState().byPage[pageKey];
      const tab = page?.tabs.find((tb) => tb.id === page.activeTabId);
      if (!tab || tab.kind === "agent") return;
      if (tab.kind === "file" && tab.dirty) setConfirming({ id: tab.id, title: tab.title });
      else useWsStore.getState().closeTabs_(pageKey, [tab.id]);
    });
    return () => off?.();
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
