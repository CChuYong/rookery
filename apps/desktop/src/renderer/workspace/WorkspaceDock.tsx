import { useEffect, useRef } from "react";
import { DockviewReact } from "dockview-react";
import type { DockviewReadyEvent, DockviewApi, Direction, SerializedDockview } from "dockview";
import { useT } from "../i18n/provider.js";
import { useWsStore, type Tab } from "../store/workspace.js";
import { useLayoutStore } from "../store/layout.js";
import { defaultPanels } from "./default-template.js";
import { fixedPanelId, editorPanelId, type FixedKind } from "./panel-ids.js";
import { dockComponents } from "./panels.js";
import "./dockview-theme.css";
import "dockview-react/dist/styles/dockview.css";

const EDITOR_PREFIX = "panel:editor:";

// One dockview workspace for one page (keyed by pageKey → remounts on page
// switch). Seeds from the default template or restores the saved layout,
// persists per-page on change, and keeps editor panels in sync with the page's
// workspace tabs. Panel content comes from the WorkspaceRender context (App).
export function WorkspaceDock({ pageKey, agentKind }: { pageKey: string; agentKind: "master" | "worker" }): JSX.Element {
  const t = useT();
  const apiRef = useRef<DockviewApi | null>(null);
  const reconcilingRef = useRef(false); // suppress closeTab_ while WE add/remove editor panels
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const titleFor = (kind: FixedKind): string => {
    switch (kind) {
      case "conversation": return agentKind === "worker" ? t("app.worker") : t("app.master");
      case "files": return t("rightSidebar.segmentFiles");
      case "git": return "Git";
      case "terminal": return "Terminal";
      case "nested": return t("rightSidebar.segmentWorker");
    }
  };

  const seed = (api: DockviewApi): void => {
    for (const sp of defaultPanels(agentKind)) {
      const id = fixedPanelId(sp.kind);
      const position = sp.anchor ? { referencePanel: fixedPanelId(sp.anchor), direction: sp.direction as Direction } : undefined;
      api.addPanel({ id, component: sp.kind, title: titleFor(sp.kind), params: { pageKey, kind: sp.kind }, ...(position ? { position } : {}) });
    }
  };

  // Reconcile editor panels against the page's non-agent workspace tabs: add
  // missing (as tabs in the conversation group), remove stale.
  const syncEditors = (api: DockviewApi | null): void => {
    if (!api) return;
    reconcilingRef.current = true;
    try {
      const tabs = (useWsStore.getState().byPage[pageKey]?.tabs ?? []).filter(
        (tb): tb is Exclude<Tab, { kind: "agent" }> => tb.kind !== "agent",
      );
      const wantIds = new Set(tabs.map((tb) => editorPanelId(tb.id)));
      for (const tb of tabs) {
        const id = editorPanelId(tb.id);
        if (api.getPanel(id)) continue;
        const conv = api.getPanel(fixedPanelId("conversation"));
        api.addPanel({
          id, component: "editor", title: tb.title, params: { pageKey, kind: "editor", tabId: tb.id },
          ...(conv ? { position: { referencePanel: conv.id, direction: "within" as Direction } } : {}),
        });
      }
      for (const p of api.panels) {
        if (p.id.startsWith(EDITOR_PREFIX) && !wantIds.has(p.id)) api.removePanel(p);
      }
    } finally {
      reconcilingRef.current = false;
    }
  };

  const persist = (api: DockviewApi): void => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { useLayoutStore.getState().save_(pageKey, api.toJSON()); }, 400);
  };

  const onReady = (event: DockviewReadyEvent): void => {
    const api = event.api;
    apiRef.current = api;
    const saved = useLayoutStore.getState().byPage[pageKey] as SerializedDockview | undefined;
    if (saved) { try { api.fromJSON(saved); } catch { api.clear(); seed(api); } }
    else seed(api);
    syncEditors(api);

    // User-closing an editor tab → reflect in the workspace store (so it isn't re-added). Programmatic reconcile is suppressed.
    api.onDidRemovePanel((e) => {
      if (reconcilingRef.current) return;
      if (e.id.startsWith(EDITOR_PREFIX)) useWsStore.getState().closeTab_(pageKey, e.id.slice(EDITOR_PREFIX.length));
    });
    api.onDidLayoutChange(() => persist(api));
  };

  // Keep editor panels in sync when tabs change elsewhere (file click, tool chip).
  useEffect(() => {
    const unsub = useWsStore.subscribe(() => syncEditors(apiRef.current));
    return () => { unsub(); if (saveTimer.current) clearTimeout(saveTimer.current); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKey]);

  return (
    <div className="dockview-theme-dark dockview-theme-rookery min-h-0 w-full flex-1">
      <DockviewReact components={dockComponents} onReady={onReady} />
    </div>
  );
}
