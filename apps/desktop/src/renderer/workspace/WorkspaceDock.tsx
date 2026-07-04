import { useEffect, useRef } from "react";
import { DockviewReact } from "dockview-react";
import type { DockviewReadyEvent, DockviewApi, Direction, SerializedDockview } from "dockview";
import { useT } from "../i18n/provider.js";
import { useWsStore, type Tab } from "../store/workspace.js";
import { useTermStore } from "../store/terminals.js";
import { useLayoutStore } from "../store/layout.js";
import { useDockPanelsStore, hideableKindsFor, type HideableKind } from "../store/dock-panels.js";
import { defaultPanels, terminalSeedHeight, isTerminalGroupCollapsed, TERMINAL_EXPANDED_HEIGHT } from "./default-template.js";
import { fixedPanelId, editorPanelId, panelIdForTab, tabIdForPanel, conversationAgentKindPatch, type FixedKind } from "./panel-ids.js";
import { fixedPanelTitle } from "./panel-titles.js";
import { dockComponents } from "./panels.js";
import { RookeryTab } from "./RookeryTab.js";
import "./dockview-theme.css";
import "dockview-react/dist/styles/dockview.css";

const EDITOR_PREFIX = "panel:editor:";
const EMPTY_HIDDEN: HideableKind[] = []; // stable ref for the "no hidden panels" case

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

  // addPanel-time translation (see panel-titles.ts) — this is what gets persisted
  // into the saved layout JSON. RookeryTab re-derives the SAME thing live on every
  // render instead of trusting that persisted value (audit #29).
  const titleFor = (kind: FixedKind): string => fixedPanelTitle(kind, t, agentKind);

  // Initial size for the panel that CREATES a group: the right sidebar group is
  // narrow, the conversation keeps the rest, and the terminal group seeds
  // collapsed (tab-strip only) unless the page already has open terminals —
  // an empty terminal shouldn't permanently occupy ~220px (audit #30).
  const seedSize = (kind: FixedKind): { initialWidth?: number; initialHeight?: number } =>
    kind === "files"
      ? { initialWidth: 320 }
      : kind === "terminal"
        ? { initialHeight: terminalSeedHeight(useTermStore.getState().layout[pageKey]?.count ?? 0) }
        : {};

  const addFixed = (api: DockviewApi, kind: FixedKind, anchor?: FixedKind, direction?: Direction): void => {
    api.addPanel({
      id: fixedPanelId(kind),
      component: kind,
      title: titleFor(kind),
      params: { pageKey, kind, ...(kind === "conversation" ? { agentKind } : {}) },
      ...seedSize(kind),
      ...(anchor ? { position: { referencePanel: fixedPanelId(anchor), direction } } : {}),
    });
  };

  const seed = (api: DockviewApi): void => {
    for (const sp of defaultPanels(agentKind)) addFixed(api, sp.kind, sp.anchor, sp.direction as Direction | undefined);
  };

  // Re-add a hidden fixed panel (audit #48) at its normal seed position when
  // possible — e.g. terminal below the conversation, git stacked with files —
  // instead of dropping it wherever dockview defaults an anchor-less addPanel
  // to. Falls back to no anchor only if that reference panel is itself absent.
  // In practice this never happens: hideableKindsFor lists "files" first, so by
  // the time "git"/"nested" (both anchored on files) are processed in the same
  // reconcile pass, files is already back; "terminal" anchors on the
  // always-present conversation, so it's order-independent.
  const reopen = (api: DockviewApi, kind: HideableKind): void => {
    const spec = defaultPanels(agentKind).find((sp) => sp.kind === kind);
    const anchor = spec?.anchor && api.getPanel(fixedPanelId(spec.anchor)) ? spec.anchor : undefined;
    addFixed(api, kind, anchor, spec?.direction as Direction | undefined);
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
    // A restored conversation panel may be missing (or disagree with) agentKind
    // in its params — re-assert the page's own known value so RookeryTab's live
    // label (params.agentKind, not the persisted title) is never wrong (task 18
    // review). Fixes existing persisted layouts without a layout-store version bump.
    const conv = api.getPanel(fixedPanelId("conversation"));
    if (conv) {
      const patch = conversationAgentKindPatch(conv.params as { agentKind?: "master" | "worker" } | undefined, agentKind);
      if (patch) conv.api.updateParameters(patch);
    }
    // Mirror actual panel presence into dockPanelsStore right after seed/restore
    // (audit #48) — the restored dockview JSON is the real source of truth for
    // "does this panel exist" (a panel closed in a previous session is simply
    // absent from it and stays absent here); this just tells the header's
    // restore toggles which fixed panels are currently hidden for this page.
    useDockPanelsStore.getState().setHidden_(pageKey, hideableKindsFor(agentKind).filter((k) => !api.getPanel(fixedPanelId(k))));
    syncEditors(api);
    syncActive(api);

    const disposables: Disposable[] = [];
    // User-closing a panel: editors → reflect in the workspace store; conversation → re-add (it must always exist);
    // any other fixed panel (Files/Git/Terminal/Nested) → mark it hidden so the header's restore toggle knows (audit #48).
    disposables.push(api.onDidRemovePanel((e) => {
      if (reconcilingRef.current || disposedRef.current) return;
      if (e.id === fixedPanelId("conversation")) { addFixed(api, "conversation"); return; }
      if (e.id.startsWith(EDITOR_PREFIX)) { useWsStore.getState().closeTab_(pageKey, e.id.slice(EDITOR_PREFIX.length)); return; }
      for (const kind of hideableKindsFor(agentKind)) {
        if (e.id === fixedPanelId(kind)) { useDockPanelsStore.getState().hide_(pageKey, kind); break; }
      }
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
    // Grow a still-collapsed terminal group once the page's first terminal opens
    // (the existing +/tab path in TerminalPanel). Only fires on a 0→>0 open-count
    // transition, and only if the group still looks like the collapsed seed —
    // never overriding a size the user picked deliberately (audit #30). This
    // deliberately ignores restore-time count churn (a page's persisted terminals
    // re-opening one by one on first view produces no 0→>0 edge, since the seed
    // already accounted for them being non-zero — see task-18-report.md).
    const unsubTerm = useTermStore.subscribe((state, prevState) => {
      const had = prevState.layout[pageKey]?.count ?? 0;
      const has = state.layout[pageKey]?.count ?? 0;
      if (had !== 0 || has === 0 || disposedRef.current) return;
      const panel = apiRef.current?.getPanel(fixedPanelId("terminal"));
      if (panel && isTerminalGroupCollapsed(panel.group.api.height)) panel.group.api.setSize({ height: TERMINAL_EXPANDED_HEIGHT });
    });
    // Header-triggered show/hide (audit #48): the header's restored terminal/right-
    // panel toggles don't touch the dockview API directly — they just flip
    // dockPanelsStore, and this reconciles actual panel presence to match. It's
    // symmetric with the onDidRemovePanel write above: a panel the USER closed via
    // its own tab-X already wrote hide_ (and is already gone), so the branches
    // below are no-ops for it (each checks actual presence before acting).
    const unsubPanels = useDockPanelsStore.subscribe((state, prevState) => {
      const api = apiRef.current;
      if (!api || disposedRef.current) return;
      const hidden = state.hiddenByPage[pageKey] ?? EMPTY_HIDDEN;
      if (hidden === (prevState.hiddenByPage[pageKey] ?? EMPTY_HIDDEN)) return;
      for (const kind of hideableKindsFor(agentKind)) {
        const panel = api.getPanel(fixedPanelId(kind));
        const shouldHide = hidden.includes(kind);
        if (shouldHide && panel) { reconcilingRef.current = true; try { api.removePanel(panel); } finally { reconcilingRef.current = false; } }
        else if (!shouldHide && !panel) reopen(api, kind);
      }
    });
    return () => {
      disposedRef.current = true;
      unsub();
      unsubTerm();
      unsubPanels();
      for (const d of disposablesRef.current) d.dispose();
      disposablesRef.current = [];
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        // Flush instead of dropping (audit #33): a layout change within the 400ms debounce of a page switch was silently lost. (Window reload/app quit still skip React cleanups — that residual sliver is accepted.)
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
