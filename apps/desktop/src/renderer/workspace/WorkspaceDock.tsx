import { useEffect, useRef } from "react";
import { DockviewReact } from "dockview-react";
import type { DockviewReadyEvent, DockviewApi, Direction, SerializedDockview } from "dockview";
import { useT } from "../i18n/provider.js";
import { useWsStore, type Tab } from "../store/workspace.js";
import { useLayoutStore } from "../store/layout.js";
import { defaultPanels } from "./default-template.js";
import { fixedPanelId, editorPanelId, panelIdForTab, tabIdForPanel, type FixedKind } from "./panel-ids.js";
import { dockComponents } from "./panels.js";
import { RookeryTab } from "./RookeryTab.js";
import "./dockview-theme.css";
import "dockview-react/dist/styles/dockview.css";

const EDITOR_PREFIX = "panel:editor:";

type Disposable = { dispose(): void }; // dockview event subscriptions return one

// One dockview workspace for one page (keyed by pageKey → remounts on page
// switch). Seeds from the default template or restores the saved layout,
// persists per-page on change, and keeps editor panels in sync with the page's
// workspace tabs. Panel content comes from the WorkspaceRender context (App).
export function WorkspaceDock({ pageKey, agentKind }: { pageKey: string; agentKind: "master" | "worker" }): JSX.Element {
  const t = useT();
  const apiRef = useRef<DockviewApi | null>(null);
  const reconcilingRef = useRef(false); // suppress closeTab_ while WE add/remove editor panels
  const disposedRef = useRef(false); // ignore dockview events fired during teardown
  const disposablesRef = useRef<Disposable[]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const titleFor = (kind: FixedKind): string => {
    switch (kind) {
      case "conversation": return agentKind === "worker" ? t("app.worker") : t("app.master");
      case "files": return t("rightSidebar.segmentFiles");
      case "git": return "Git";
      case "terminal": return t("workspaceHeaders.terminalTitle");
      case "nested": return t("rightSidebar.segmentWorker");
    }
  };

  // Initial size for the panel that CREATES a group: the right sidebar group is
  // narrow, the terminal group is short; the conversation keeps the rest.
  const seedSize = (kind: FixedKind): { initialWidth?: number; initialHeight?: number } =>
    kind === "files" ? { initialWidth: 320 } : kind === "terminal" ? { initialHeight: 220 } : {};

  const addFixed = (api: DockviewApi, kind: FixedKind, anchor?: FixedKind, direction?: Direction): void => {
    api.addPanel({
      id: fixedPanelId(kind),
      component: kind,
      title: titleFor(kind),
      params: { pageKey, kind },
      ...seedSize(kind),
      ...(anchor ? { position: { referencePanel: fixedPanelId(anchor), direction } } : {}),
    });
  };

  const seed = (api: DockviewApi): void => {
    for (const sp of defaultPanels(agentKind)) addFixed(api, sp.kind, sp.anchor, sp.direction as Direction | undefined);
  };

  // Reconcile editor panels against the page's non-agent workspace tabs: add
  // missing (as tabs in the conversation group), remove stale.
  const syncEditors = (api: DockviewApi | null): void => {
    if (!api || disposedRef.current) return;
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

  // Store → dock: focus the panel for the store's active tab. Re-clicking an already-open file in the
  // FileTree only writes activeTabId (openFile_ early-returns when the tab exists) — without this, the click
  // was a silent no-op while the panel stayed buried behind another tab (audit #20).
  const syncActive = (api: DockviewApi | null): void => {
    if (!api || disposedRef.current) return;
    const want = panelIdForTab(useWsStore.getState().byPage[pageKey]?.activeTabId ?? "agent");
    if (api.activePanel?.id === want) return;
    const panel = api.getPanel(want);
    if (!panel) return;
    reconcilingRef.current = true;
    try { panel.api.setActive(); } finally { reconcilingRef.current = false; }
  };

  const persist = (api: DockviewApi): void => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { if (!disposedRef.current) useLayoutStore.getState().save_(pageKey, api.toJSON()); }, 400);
  };

  const onReady = (event: DockviewReadyEvent): void => {
    const api = event.api;
    apiRef.current = api;
    const saved = useLayoutStore.getState().byPage[pageKey] as SerializedDockview | undefined;
    if (saved) { try { api.fromJSON(saved); } catch { api.clear(); seed(api); } }
    else seed(api);
    // The conversation is the primary panel — if a restored layout dropped it, re-seed it.
    if (!api.getPanel(fixedPanelId("conversation"))) addFixed(api, "conversation");
    syncEditors(api);
    syncActive(api);

    const disposables: Disposable[] = [];
    // User-closing a panel: editors → reflect in the workspace store; conversation → re-add (it must always exist).
    disposables.push(api.onDidRemovePanel((e) => {
      if (reconcilingRef.current || disposedRef.current) return;
      if (e.id === fixedPanelId("conversation")) { addFixed(api, "conversation"); return; }
      if (e.id.startsWith(EDITOR_PREFIX)) useWsStore.getState().closeTab_(pageKey, e.id.slice(EDITOR_PREFIX.length));
    }));
    // Dock → store: clicking a dock tab makes it the workspace-active tab, so the FileTree highlight and any
    // store-driven consumers track the actually-focused panel. Fixed non-tab panels (files/git/terminal) are
    // not tabs — they don't touch activeTabId.
    disposables.push(api.onDidActivePanelChange((e) => {
      const p = e.panel;
      if (reconcilingRef.current || disposedRef.current || !p) return;
      const tabId = tabIdForPanel(p.id);
      if (!tabId) return;
      if ((useWsStore.getState().byPage[pageKey]?.activeTabId ?? "agent") !== tabId) useWsStore.getState().setActive_(pageKey, tabId);
    }));
    disposables.push(api.onDidLayoutChange(() => persist(api)));
    disposablesRef.current = disposables;
  };

  // Keep editor panels in sync when tabs change elsewhere (file click, tool chip).
  useEffect(() => {
    disposedRef.current = false;
    const unsub = useWsStore.subscribe((state, prevState) => {
      syncEditors(apiRef.current);
      // Gate the focus sync on THIS page's tab state actually changing: every useWsStore write fires this
      // listener, and force-activating the tab panel on unrelated writes (expandedByPage from a folder toggle,
      // setDirty from a file watch) steals activation from focused FIXED panels (files/git/terminal). A re-click
      // of an open tab still passes — openFile/setActive always produce a NEW byPage[pageKey] object.
      if (state.byPage[pageKey] !== prevState.byPage[pageKey]) syncActive(apiRef.current);
    });
    return () => {
      disposedRef.current = true;
      unsub();
      for (const d of disposablesRef.current) d.dispose();
      disposablesRef.current = [];
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        // Flush instead of dropping (audit #33): a layout change within the 400ms debounce of a page switch,
        // reload, or quit was silently lost and the page reverted to its previous saved arrangement.
        const api = apiRef.current;
        if (api) { try { useLayoutStore.getState().save_(pageKey, api.toJSON()); } catch { /* dockview mid-teardown — keep the last saved layout */ } }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKey]);

  return (
    <div className="dockview-theme-dark dockview-theme-rookery min-h-0 w-full flex-1">
      <DockviewReact components={dockComponents} defaultTabComponent={RookeryTab} onReady={onReady} />
    </div>
  );
}
