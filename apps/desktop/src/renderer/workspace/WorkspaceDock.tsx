import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { DockviewReact } from "dockview-react";
import type { DockviewReadyEvent, DockviewApi, AddPanelPositionOptions, SerializedDockview, DockviewTheme } from "dockview";
import { useT } from "../i18n/provider.js";
import { useWsStore, type Tab } from "../store/workspace.js";
import { useTermStore } from "../store/terminals.js";
import { useLayoutStore } from "../store/layout.js";
import { useDockPanelsStore, hideableKindsFor, type HideableKind } from "../store/dock-panels.js";
import { toast } from "../store/toasts.js";
import { shouldCompactDock } from "../lib/layout-budget.js";
import { useCloseTabShortcut } from "../lib/useCloseTabShortcut.js";
import { defaultPanels, terminalSeedHeight, isTerminalGroupCollapsed, TERMINAL_EXPANDED_HEIGHT, type SeedPanel } from "./default-template.js";
import { fixedPanelId, editorPanelId, panelIdForTab, tabIdForPanel, conversationAgentKindPatch, type FixedKind } from "./panel-ids.js";
import { fixedPanelTitle } from "./panel-titles.js";
import { dockComponents } from "./panels.js";
import { RookeryTab } from "./RookeryTab.js";
import {
  applyDockConstraints,
  autoHideableRightGroups,
  hidePanels,
  isKindVisible,
  panelKind,
  reopenPosition,
  resetDockSizes,
  requiredDockWidth,
  savedSideColumnWidth,
  setSideColumnWidth,
  sideColumnWidth,
  unhideLeaves,
  INSPECTOR_DEFAULT_WIDTH,
  type SerializedGrid,
} from "./dock-layout.js";
import { enhanceOverflowHandles, enhanceOverflowMenus, revealActiveTabs, sashAxis, touchesTabChrome } from "./dock-dom.js";
import "./dockview-theme.css";

// dockview v7 applies its own theme class to the shell (default: Abyss, a navy palette) and that class wins over
// ancestor variables, so the Rookery theme must be passed explicitly for the token overrides to take effect.
const ROOKERY_DOCK_THEME: DockviewTheme = { name: "rookery", className: "dockview-theme-dark dockview-theme-rookery", colorScheme: "dark" };
import "dockview-react/dist/styles/dockview.css";

const EDITOR_PREFIX = "panel:editor:";
const EMPTY_HIDDEN: HideableKind[] = []; // stable ref for the "no hidden panels" case

type Disposable = { dispose(): void }; // dockview event subscriptions return one

// Live docks by page, so a Reset-layout Undo clicked after the dock remounted still reaches the dock on screen.
const liveDocks = new Map<string, (json: SerializedDockview) => void>();

function sameKinds(a: readonly HideableKind[], b: readonly HideableKind[]): boolean {
  return a.length === b.length && a.every((k) => b.includes(k));
}

// One dockview workspace for one page (keyed by pageKey → remounts on page switch). Seeds from the default template
// or restores the saved layout, persists per-page on change, and keeps editor panels in sync with the page's
// workspace tabs. Panel content comes from the WorkspaceRender context (App).
//
// Panel visibility has two independent sources (audit #4 #7): the user's choice (dockPanelsStore.hiddenByPage, also
// written when a tab's × closes a panel) and the narrow-window rule (autoHiddenByPage, written only here). The dock
// is reconciled to "hidden = either". Hiding a whole group uses dockview's group visibility, so the group keeps its
// place and size and comes back exactly as it was (audit #5); a panel sharing a group with others is removed instead.
// `onApi` is a test seam: it hands out the live DockviewApi so a test can drive real container sizes.
export function WorkspaceDock({ pageKey, agentKind, onApi }: { pageKey: string; agentKind: "master" | "worker"; onApi?: (api: DockviewApi) => void }): JSX.Element {
  const t = useT();
  const apiRef = useRef<DockviewApi | null>(null);
  const reconcilingRef = useRef(false); // suppress store writes while WE add/remove/hide panels
  const selfWriteRef = useRef(false); // dockPanelsStore writes made by this dock (it reconciles itself after them)
  const disposedRef = useRef(false); // ignore dockview events fired during teardown
  const disposablesRef = useRef<Disposable[]>([]);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  // Narrow-window state, measured on the dock itself (not viewport minus sidebar) — audit #4.
  const [compact, setCompact] = useState(false);
  const compactRef = useRef(compact);
  compactRef.current = compact;
  const appliedCompactRef = useRef<boolean | null>(null); // the compact value the dock last acted on
  const dockWidthRef = useRef(0);
  // The side column width the user chose (seed/default, saved layout, last sash drag). Shrinking the window squeezes
  // the column proportionally — down to its minimum before the narrow rule hides it — so this, not the live width, is
  // what comes back and what gets saved (review fix 1).
  const sideWidthRef = useRef(INSPECTOR_DEFAULT_WIDTH);
  const closeTabConfirm = useCloseTabShortcut(pageKey);

  // addPanel-time translation (see panel-titles.ts) — this is what gets persisted into the saved layout JSON.
  // RookeryTab re-derives the SAME thing live on every render instead of trusting that persisted value (audit #29).
  const titleFor = (kind: FixedKind): string => fixedPanelTitle(kind, t, agentKind);
  const termCount = (): number => useTermStore.getState().layout[pageKey]?.count ?? 0;
  const dockState = () => useDockPanelsStore.getState();
  const autoHidden = (): HideableKind[] => dockState().autoHiddenByPage[pageKey] ?? EMPTY_HIDDEN;

  // Initial size for the panel that CREATES a group: the side column is narrow, the conversation keeps the rest,
  // and the terminal group seeds collapsed (tab-strip only) unless the page already has open terminals (audit #30).
  const seedSize = (kind: FixedKind): { initialWidth?: number; initialHeight?: number } =>
    kind === "files" || kind === "git" || kind === "nested"
      ? { initialWidth: INSPECTOR_DEFAULT_WIDTH }
      : kind === "terminal"
        ? { initialHeight: terminalSeedHeight(termCount()) }
        : {};

  const addFixed = (api: DockviewApi, kind: FixedKind, position?: AddPanelPositionOptions, inactive = false): void => {
    api.addPanel({
      id: fixedPanelId(kind),
      component: kind,
      title: titleFor(kind),
      params: { pageKey, kind, ...(kind === "conversation" ? { agentKind } : {}) },
      ...seedSize(kind),
      ...(position ? { position } : {}),
      ...(inactive ? { inactive: true } : {}),
    });
  };

  const seedPosition = (sp: SeedPanel): AddPanelPositionOptions | undefined =>
    sp.anchor ? { referencePanel: fixedPanelId(sp.anchor), direction: sp.direction ?? "within" } : sp.direction && sp.direction !== "within" ? { direction: sp.direction } : undefined;

  // The terminal starts closed on a fresh page (open it from the header toggle or Ctrl+`); a page that already had
  // terminals open keeps it, and so does a Reset while the terminal panel is showing (audit #79). The worker's
  // Activity panel joins its group inactive, so the side column opens on Git rather than a mostly empty Activity
  // tab (audit #13).
  const seed = (api: DockviewApi, keepTerminal = false): void => {
    for (const sp of defaultPanels(agentKind)) {
      if (sp.kind === "terminal" && termCount() === 0 && !keepTerminal) continue;
      addFixed(api, sp.kind, seedPosition(sp), sp.kind === "nested");
    }
  };

  // Re-add a closed fixed panel (audit #48): side panels join a remaining side group or open as a full-height
  // column on the dock's right edge; the terminal goes below the conversation (see reopenPosition).
  const reopen = (api: DockviewApi, kind: HideableKind): void => addFixed(api, kind, reopenPosition(kind, api));

  // Kinds the user has hidden = not visible in the dock and not hidden by the narrow-window rule.
  const userHiddenNow = (api: DockviewApi): HideableKind[] => {
    const auto = autoHidden();
    return hideableKindsFor(agentKind).filter((k) => !isKindVisible(api, k) && !auto.includes(k));
  };
  const selfWrite = (write: () => void): void => {
    selfWriteRef.current = true;
    try { write(); } finally { selfWriteRef.current = false; }
  };
  const mirrorHidden = (api: DockviewApi): void => {
    const next = userHiddenNow(api);
    if (!sameKinds(next, dockState().hiddenByPage[pageKey] ?? EMPTY_HIDDEN)) selfWrite(() => dockState().setHidden_(pageKey, next));
  };

  // Bring the dock in line with "hidden = user-hidden ∪ auto-hidden".
  const reconcileVisibility = (api: DockviewApi): void => {
    const hidden = dockState().hiddenByPage[pageKey] ?? EMPTY_HIDDEN;
    const auto = autoHidden();
    const kinds = hideableKindsFor(agentKind);
    const wantHidden = (k: HideableKind): boolean => hidden.includes(k) || auto.includes(k);
    const toShow = kinds.filter((k) => !wantHidden(k) && !isKindVisible(api, k));
    if (toShow.length === 0 && !kinds.some((k) => wantHidden(k) && isKindVisible(api, k))) return;
    reconcilingRef.current = true;
    try {
      // Groups that are merely hidden come back first (at their remembered size); then missing panels are re-added
      // in template order, so git/nested find the files group again.
      for (const k of toShow) api.getPanel(fixedPanelId(k))?.group.api.setVisible(true);
      for (const k of toShow) if (!api.getPanel(fixedPanelId(k))) reopen(api, k);
      if (toShow.some((k) => k !== "terminal")) setSideColumnWidth(api, sideWidthRef.current);
      // Hide last: showing a group can also reveal a panel that should stay hidden alongside one that shouldn't.
      hidePanels(api, kinds.filter((k) => wantHidden(k) && isKindVisible(api, k)));
    } finally {
      reconcilingRef.current = false;
    }
    applyDockConstraints(api);
  };

  // Narrow-window rule: entering compact hides the visible side-only groups and records them as auto-hidden;
  // leaving it clears the record, and the reconcile shows them again at the width they had (audit #4 #5).
  const applyCompact = (api: DockviewApi, nextCompact: boolean): void => {
    appliedCompactRef.current = nextCompact;
    if (nextCompact) {
      const kinds = autoHideableRightGroups(api).flatMap((g) => g.panels.map(panelKind)) as HideableKind[];
      const merged = [...new Set([...autoHidden(), ...kinds])];
      if (!sameKinds(merged, autoHidden())) selfWrite(() => dockState().setAutoHidden_(pageKey, merged));
    } else if (autoHidden().length > 0) {
      selfWrite(() => dockState().setAutoHidden_(pageKey, []));
    }
    reconcileVisibility(api);
  };

  // The layout to save: identical to the live one, except groups hidden only by the narrow-window rule are saved
  // visible at their own width, so changes made in a narrow window persist without losing the side panel (#81).
  const serialize = (api: DockviewApi): SerializedDockview => {
    const json = api.toJSON();
    const auto = autoHidden();
    if (auto.length === 0) return json;
    const ids = new Set(api.groups.filter((g) => !g.api.isVisible && g.panels.length > 0 && g.panels.every((p) => auto.includes(panelKind(p) as HideableKind))).map((g) => g.id));
    return { ...json, grid: unhideLeaves(json.grid as unknown as SerializedGrid, ids, () => sideWidthRef.current) as unknown as SerializedDockview["grid"] };
  };

  // Reconcile editor panels against the page's non-agent workspace tabs: add missing (as tabs in the conversation
  // group), remove stale.
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
          ...(conv ? { position: { referencePanel: conv.id, direction: "within" as const } } : {}),
        });
      }
      for (const p of api.panels) {
        if (p.id.startsWith(EDITOR_PREFIX) && !wantIds.has(p.id)) api.removePanel(p);
      }
    } finally {
      reconcilingRef.current = false;
    }
  };

  // Store → dock: focus the panel for the store's active tab. Re-clicking an already-open file in the FileTree only
  // writes activeTabId (openFile_ early-returns when the tab exists) — without this, the click was a silent no-op
  // while the panel stayed buried behind another tab (audit #20).
  const syncActive = (api: DockviewApi | null): void => {
    if (!api || disposedRef.current) return;
    const want = panelIdForTab(useWsStore.getState().byPage[pageKey]?.activeTabId ?? "agent");
    if (api.activePanel?.id === want) return;
    const panel = api.getPanel(want);
    if (!panel) return;
    reconcilingRef.current = true;
    try { panel.api.setActive(); } finally { reconcilingRef.current = false; }
  };

  // Narrow = below the comfort width, or too narrow for every column at its minimum (review fix 8).
  const isCompactFor = (api: DockviewApi | null, width: number): boolean =>
    width > 0 && (shouldCompactDock(width) || (!!api && width < requiredDockWidth(api)));

  // Outside the narrow rule, the side column keeps the width the user chose while the window resizes (an IDE
  // sidebar keeps its pixels) instead of drifting with dockview's proportional resize.
  const keepSideWidth = (api: DockviewApi): void => {
    if (!compactRef.current) setSideColumnWidth(api, sideWidthRef.current);
  };

  const persist = (api: DockviewApi): void => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { if (!disposedRef.current) useLayoutStore.getState().save_(pageKey, serialize(api)); }, 400);
  };

  const revealTabsSoon = (): void => {
    requestAnimationFrame(() => { if (!disposedRef.current && wrapperRef.current) revealActiveTabs(wrapperRef.current); });
  };

  // Everything that must hold after the dock's content was replaced (restore, reset, undo).
  const afterContentChange = (api: DockviewApi): void => {
    // The conversation is the primary panel — if a restored layout dropped it, re-seed it.
    if (!api.getPanel(fixedPanelId("conversation"))) addFixed(api, "conversation");
    // A restored conversation panel may be missing (or disagree with) agentKind in its params — re-assert the page's
    // own known value so RookeryTab's live label (params.agentKind, not the persisted title) is never wrong.
    const conv = api.getPanel(fixedPanelId("conversation"));
    if (conv) {
      const patch = conversationAgentKindPatch(conv.params as { agentKind?: "master" | "worker" } | undefined, agentKind);
      if (patch) conv.api.updateParameters(patch);
    }
    // Constraints are applied on every load, so layouts saved before they existed (a crushed conversation, a side
    // panel stretched to half the window) snap back inside the limits (audit #1 #3, Review focus 2).
    applyDockConstraints(api);
    // Any group the restored JSON has hidden was hidden by the user (auto-hidden groups are saved visible).
    if (autoHidden().length > 0) selfWrite(() => dockState().setAutoHidden_(pageKey, []));
    mirrorHidden(api);
    applyCompact(api, compactRef.current);
    syncEditors(api);
    syncActive(api);
    revealTabsSoon();
  };

  const loadJson = (api: DockviewApi, json: SerializedDockview | undefined): void => {
    sideWidthRef.current = (json && savedSideColumnWidth(json.grid as unknown as SerializedGrid)) || INSPECTOR_DEFAULT_WIDTH;
    reconcilingRef.current = true;
    try {
      if (json) { try { api.fromJSON(json); } catch { api.clear(); seed(api); } }
      else { api.clear(); seed(api); }
    } finally {
      reconcilingRef.current = false;
    }
    afterContentChange(api);
  };

  // Reset layout (audit #57 #79 #81): reseed this page's dock — keeping a showing terminal — and offer Undo.
  const resetLayout = (api: DockviewApi): void => {
    const previous = serialize(api);
    const keepTerminal = isKindVisible(api, "terminal");
    sideWidthRef.current = INSPECTOR_DEFAULT_WIDTH;
    reconcilingRef.current = true;
    try { api.clear(); seed(api, keepTerminal); } finally { reconcilingRef.current = false; }
    afterContentChange(api);
    persist(api);
    toast.info(t("workspaceHeaders.layoutReset"), {
      label: t("workspaceHeaders.undo"),
      onClick: () => {
        const live = liveDocks.get(pageKey);
        if (live) live(previous);
        else useLayoutStore.getState().save_(pageKey, previous);
      },
    });
  };

  const onReady = (event: DockviewReadyEvent): void => {
    const api = event.api;
    apiRef.current = api;
    onApi?.(api);
    // Measure once up front so a page opened in a narrow window doesn't flash its side panel before the
    // ResizeObserver's first callback.
    const startWidth = wrapperRef.current?.clientWidth ?? 0;
    dockWidthRef.current = startWidth;
    if (startWidth > 0) compactRef.current = shouldCompactDock(startWidth);
    loadJson(api, useLayoutStore.getState().byPage[pageKey] as SerializedDockview | undefined);
    // Now that the layout is known, include its column minimums in the decision (review fix 8).
    if (startWidth > 0) {
      const next = isCompactFor(api, startWidth);
      if (next !== compactRef.current) { compactRef.current = next; applyCompact(api, next); }
      setCompact(next);
    }

    const disposables: Disposable[] = [];
    // User-closing a panel: editors → reflect in the workspace store; conversation → re-add (it must always exist);
    // any other fixed panel (Files/Git/Terminal/Nested) → mark it hidden so the header's toggle knows (audit #48).
    disposables.push(api.onDidRemovePanel((e) => {
      if (reconcilingRef.current || disposedRef.current) return;
      if (e.id === fixedPanelId("conversation")) { addFixed(api, "conversation"); return; }
      if (e.id.startsWith(EDITOR_PREFIX)) { useWsStore.getState().closeTab_(pageKey, e.id.slice(EDITOR_PREFIX.length)); return; }
      for (const kind of hideableKindsFor(agentKind)) {
        if (e.id === fixedPanelId(kind)) { selfWrite(() => dockState().hide_(pageKey, kind)); break; }
      }
    }));
    // Dock → store: clicking a dock tab makes it the workspace-active tab, so the FileTree highlight and any
    // store-driven consumers track the actually-focused panel. Fixed non-tab panels (files/git/terminal) are not
    // tabs — they don't touch activeTabId.
    disposables.push(api.onDidActivePanelChange((e) => {
      const p = e.panel;
      if (reconcilingRef.current || disposedRef.current || !p) return;
      const tabId = tabIdForPanel(p.id);
      if (!tabId) return;
      if ((useWsStore.getState().byPage[pageKey]?.activeTabId ?? "agent") !== tabId) useWsStore.getState().setActive_(pageKey, tabId);
    }));
    // Panels moving between groups (drag and drop) change which constraints each group needs.
    let constraintsQueued = false;
    const queueConstraints = (): void => {
      if (constraintsQueued) return;
      constraintsQueued = true;
      queueMicrotask(() => {
        constraintsQueued = false;
        if (disposedRef.current) return;
        applyDockConstraints(api);
        // A new column (e.g. an editor split beside the conversation) can raise the width the dock needs.
        if (dockWidthRef.current > 0) setCompact(isCompactFor(api, dockWidthRef.current));
      });
    };
    disposables.push(api.onDidAddPanel(queueConstraints), api.onDidMovePanel(queueConstraints), api.onDidRemoveGroup(queueConstraints));
    disposables.push(api.onDidLayoutChange(() => {
      if (disposedRef.current) return;
      persist(api);
      revealTabsSoon();
    }));
    disposablesRef.current = disposables;
  };

  useEffect(() => {
    disposedRef.current = false;
    liveDocks.set(pageKey, (json) => {
      const api = apiRef.current;
      if (api && !disposedRef.current) { loadJson(api, json); persist(api); }
    });
    // Keep editor panels in sync when tabs change elsewhere (file click, tool chip).
    const unsub = useWsStore.subscribe((state, prevState) => {
      syncEditors(apiRef.current);
      // Gate the focus sync on THIS page's tab state actually changing: every useWsStore write fires this listener,
      // and force-activating the tab panel on unrelated writes (expandedByPage from a folder toggle, setDirty from a
      // file watch) steals activation from focused FIXED panels (files/git/terminal). A re-click of an open tab still
      // passes — openFile/setActive always produce a NEW byPage[pageKey] object.
      if (state.byPage[pageKey] !== prevState.byPage[pageKey]) syncActive(apiRef.current);
    });
    // Grow a still-collapsed terminal group once the page's first terminal opens. Only fires on a 0→>0 open-count
    // transition, and only if the group still looks like the collapsed seed — never overriding a size the user
    // picked deliberately (audit #30).
    const unsubTerm = useTermStore.subscribe((state, prevState) => {
      const had = prevState.layout[pageKey]?.count ?? 0;
      const has = state.layout[pageKey]?.count ?? 0;
      if (had !== 0 || has === 0 || disposedRef.current) return;
      const panel = apiRef.current?.getPanel(fixedPanelId("terminal"));
      if (panel && isTerminalGroupCollapsed(panel.group.api.height)) panel.group.api.setSize({ height: TERMINAL_EXPANDED_HEIGHT });
    });
    // Header toggles / Ctrl+` only write dockPanelsStore; this reconciles the dock to it (audit #48). A terminal the
    // user just showed on a page with no shell asks the TerminalPanel to open one, so one press gives a prompt
    // instead of an empty strip (audit #80).
    const unsubPanels = useDockPanelsStore.subscribe((state, prevState) => {
      const api = apiRef.current;
      if (!api || disposedRef.current || reconcilingRef.current || selfWriteRef.current) return;
      const hidden = state.hiddenByPage[pageKey] ?? EMPTY_HIDDEN;
      const prevHidden = prevState.hiddenByPage[pageKey] ?? EMPTY_HIDDEN;
      if (hidden === prevHidden && (state.autoHiddenByPage[pageKey] ?? EMPTY_HIDDEN) === (prevState.autoHiddenByPage[pageKey] ?? EMPTY_HIDDEN)) return;
      const terminalShown = prevHidden.includes("terminal") && !hidden.includes("terminal");
      reconcileVisibility(api);
      if (terminalShown && termCount() === 0) useTermStore.getState().requestShell_(pageKey);
    });
    // Header "Reset layout" bumps this page's reset counter (works with or without a saved layout, audit #81).
    const unsubLayout = useLayoutStore.subscribe((state, prevState) => {
      const api = apiRef.current;
      if (!api || disposedRef.current) return;
      if ((state.resetSeq[pageKey] ?? 0) === (prevState.resetSeq[pageKey] ?? 0)) return;
      resetLayout(api);
    });
    return () => {
      disposedRef.current = true;
      liveDocks.delete(pageKey);
      unsub();
      unsubTerm();
      unsubPanels();
      unsubLayout();
      for (const d of disposablesRef.current) d.dispose();
      disposablesRef.current = [];
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        // Flush instead of dropping (audit #33): a layout change within the 400ms debounce of a page switch was
        // silently lost. (Window reload/app quit still skip React cleanups — that residual sliver is accepted.)
        const api = apiRef.current;
        if (api) { try { useLayoutStore.getState().save_(pageKey, serialize(api)); } catch { /* dockview mid-teardown — keep the last saved layout */ } }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pageKey]);

  // Ctrl+` toggles this page's terminal (VS Code's binding), the keyboard twin of the header's terminal toggle.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.ctrlKey || e.metaKey || e.altKey || e.code !== "Backquote") return;
      e.preventDefault();
      useDockPanelsStore.getState().toggle_(pageKey, "terminal");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pageKey]);

  // Measure the dock itself for the narrow-window rule and keep the active tabs in view while it resizes (#2 #4).
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) {
        dockWidthRef.current = width;
        const next = isCompactFor(apiRef.current, width);
        compactRef.current = next; // read by keepSideWidth below before React re-renders
        setCompact(next);
      }
      // After dockview's own resize pass: hold the side column at its chosen width, keep active tabs in view.
      requestAnimationFrame(() => {
        const api = apiRef.current;
        if (disposedRef.current || !api) return;
        keepSideWidth(api);
        if (wrapperRef.current) revealActiveTabs(wrapperRef.current);
      });
    });
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const api = apiRef.current;
    // Act only on a real change: onReady may already have applied the measured value, and this effect's first run
    // sees the stale first-render state — re-applying it flashed the side column hide → show → hide (review fix 3).
    // compactRef, not the render's `compact`: onReady (which runs after this render) may have measured a newer value.
    const want = compactRef.current;
    if (api && !disposedRef.current && appliedCompactRef.current !== want) applyCompact(api, want);
    // applyCompact closes over this page's stable pageKey/agentKind and is only driven by the measured flag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compact]);

  // dockview's tab-overflow chevron: give it button semantics and a name (audit #71); it is created and updated by
  // dockview at any time, so watch the dock's DOM for it.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const label = (count: number): string => t("workspaceHeaders.overflowTabs", { count });
    const enhance = (): void => { enhanceOverflowHandles(el, label); enhanceOverflowMenus(el); };
    enhance();
    // Only tab chrome matters; the panels' content (streamed transcript, xterm, Monaco) mutates constantly, so the
    // records are filtered and the work is batched to one frame (review fix 5).
    let queued = false;
    const mo = new MutationObserver((records) => {
      if (queued || !touchesTabChrome(records)) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; enhance(); });
    });
    mo.observe(el, { childList: true, subtree: true });
    return () => mo.disconnect();
  }, [t]);

  // Double-click a sash: the dimension that sash controls goes back to its default — side column width for a sash
  // between columns, terminal height for one between rows (audit #106, review fix 6).
  const onDoubleClick = (e: ReactMouseEvent): void => {
    const api = apiRef.current;
    const axis = api && e.target instanceof Element ? sashAxis(e.target) : null;
    if (!api || !axis) return;
    if (axis === "width") sideWidthRef.current = INSPECTOR_DEFAULT_WIDTH;
    resetDockSizes(api, terminalSeedHeight(termCount()), axis);
  };

  // A finished sash drag records the side column width as the user's choice (only outside the narrow rule, where
  // the width is not being forced down).
  const onPointerDownCapture = (e: ReactPointerEvent): void => {
    if (!(e.target instanceof Element) || !e.target.closest(".dv-sash")) return;
    const onUp = (): void => {
      window.removeEventListener("pointerup", onUp);
      const api = apiRef.current;
      if (!api || disposedRef.current || compactRef.current) return;
      const width = sideColumnWidth(api);
      if (width) sideWidthRef.current = width;
    };
    window.addEventListener("pointerup", onUp);
  };

  return (
    <div ref={wrapperRef} onDoubleClick={onDoubleClick} onPointerDownCapture={onPointerDownCapture} className="dockview-theme-dark dockview-theme-rookery min-h-0 w-full flex-1">
      <DockviewReact components={dockComponents} defaultTabComponent={RookeryTab} onReady={onReady} theme={ROOKERY_DOCK_THEME} />
      {closeTabConfirm}
    </div>
  );
}
