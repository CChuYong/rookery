import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelLeftClose, PanelLeft, ChevronLeft, ChevronRight, Settings, Bell, BellOff, Plus, Clock, RotateCcw, Loader2 } from "lucide-react";
import type { SettingsValues } from "@daemon/core/settings.js";
import type { SourceItem } from "@daemon/core/source-intake.js";
import type { Automation } from "@daemon/persistence/repositories.js";
import { useStore } from "./store/store.js";
import { baseName } from "./lib/path.js";
import { useShallow } from "zustand/react/shallow";
import { WsClient } from "./ws/client.js";
import type { SocketLike } from "./ws/client.js";
import { Sessions } from "./views/Sessions.js";
import { ConversationPane } from "./components/ConversationPane.js";
import { ResizeHandle } from "./components/ResizeHandle.js";
import { useResizableWidth } from "./lib/useResizableWidth.js";
import { useMountTransition } from "./lib/useMountTransition.js";
import { useJustEnded } from "./lib/useJustEnded.js";
import { notifyFor } from "./lib/notify.js";
import { useT } from "./i18n/provider.js";
import { RepoTree } from "./views/RepoTree.js";
import { RepoModal } from "./components/RepoModal.js";
import { WorkerSpawnModal } from "./components/WorkerSpawnModal.js";
import { DataConsentModal } from "./components/DataConsentModal.js";
import { OnboardingModal } from "./components/OnboardingModal.js";
import { GettingStartedChecklist } from "./components/GettingStartedChecklist.js";
import { usePrefsStore } from "./store/prefs.js";
import type { Checkpoint } from "./components/CheckpointMenu.js";
import { NewSessionPage } from "./components/NewSessionPage.js";
import type { SlashCommand } from "./views/Conversation.js";
import { AutomationPage } from "./components/AutomationPage.js";
import { AutomationForm } from "./components/AutomationForm.js";
import { WorkerHeader, SessionHeader } from "./components/WorkspaceHeaders.js";
import { WindowControls } from "./components/WindowControls.js";
import { DaemonDownBanner } from "./components/DaemonDownBanner.js";
import { Tooltip } from "./components/Tooltip.js";
import { RestartDaemonDialog } from "./components/RestartDaemonDialog.js";
import { UsagePanel } from "./components/UsagePanel.js";
import { ResourceMonitor } from "./components/ResourceMonitor.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { Button } from "./ui/button.js";
import { Toaster } from "./components/Toaster.js";
import { toast } from "./store/toasts.js";
import { cn } from "./lib/cn.js";
import type { RookeryTerm, RookeryWs, RookeryFs, RookeryResources, RookeryApps, RookeryWin, RookeryUpdate, ResourceSnapshot } from "./types/rookery.js";
import { TerminalPanel } from "./components/TerminalPanel.js";
import { useTermStore, pruneLayout } from "./store/terminals.js";
import { RightSidebar } from "./components/RightSidebar.js";
import { useWsStore, pruneWsPages } from "./store/workspace.js";
import { useLayoutStore } from "./store/layout.js";
import { useDraftStore, pruneDrafts } from "./store/drafts.js";
import { readViewState, writeViewState } from "./lib/view-state.js";
import { WorkspaceTab } from "./components/WorkspaceTab.js";
import { TabBar } from "./components/TabBar.js";
import { isDockableEnabled } from "./lib/flags.js";
import { WorkspaceDock } from "./workspace/WorkspaceDock.js";
import { WorkspaceRenderProvider, type WorkspaceRender } from "./workspace/WorkspaceRender.js";
import { NestedPanelBody } from "./workspace/panels.js";
import { FileTree } from "./components/FileTree.js";
import { GitChanges } from "./components/GitChanges.js";
import { useTreeVersion } from "./lib/useTreeVersion.js";

declare global {
  interface Window {
    rookery: { daemon: { ensure(): Promise<string>; status(): Promise<string>; restart(): Promise<string> }; wsUrl(): Promise<string>; pickDirectory(): Promise<string | null>; pickFile(): Promise<string | null>; openExternal(url: string): Promise<void>; getPathForFile(file: File): string; system: { getLocale(): Promise<string>; setLocale(locale: string): void }; term: RookeryTerm; ws: RookeryWs; fs: RookeryFs; resources: RookeryResources; apps: RookeryApps; notify(p: { title: string; body: string; workerId: string }): Promise<void>; onNotifyClick(cb: (workerId: string) => void): () => void; platform: string; win: RookeryWin; getVersion(): Promise<string>; update: RookeryUpdate };
  }
}

let client: WsClient | null = null;
let sessionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let usageTimer: ReturnType<typeof setTimeout> | null = null;
let startTimer: ReturnType<typeof setTimeout> | null = null; // DSK-10: fallback timer to recover from a stuck 'starting' state (refreshed on every connect)

// Poll the usage snapshot. Fast (4s) before data arrives, slow (45s) once it does — lightweight since it only reads the cache.
function pollUsage(c: WsClient): void {
  const schedule = (ms: number) => {
    if (usageTimer) clearTimeout(usageTimer);
    usageTimer = setTimeout(tick, ms);
  };
  const tick = () => {
    void c
      .request({ type: "usage.get" })
      .then((r) => {
        useStore.getState().setUsage(r.usage);
        const ready = !!(r.usage && (r.usage.pct || r.usage.today));
        schedule(ready ? 45000 : 4000);
      })
      .catch(() => schedule(8000));
  };
  tick();
}

// Debounce-refresh the session list on activity/new-session events (re-sort by activity + surface sessions created via other paths).
function scheduleSessionRefresh(c: WsClient): void {
  if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer);
  sessionRefreshTimer = setTimeout(() => {
    sessionRefreshTimer = null;
    void c.request({ type: "session.list" }).then((r) => useStore.getState().setSessions(r.sessions ?? [])).catch(() => {});
  }, 400);
}

// Selector return type narrowed to only the store fields App actually reads. Never include high-frequency
// log maps (session/worker transcript, nested panel) — those reads are moved into children
// (ConversationPane/SessionMetrics/RightSidebar) to stop the whole App from re-rendering on every token delta.
// If a field is missing, tsc catches it at the s.X access.
type AppSelected = Pick<
  ReturnType<typeof useStore.getState>,
  | "overlay"
  | "showRepos"
  | "activeSessionId"
  | "activeWorkerId"
  | "navBack"
  | "navFwd"
  | "navigate"
  | "goBack"
  | "goForward"
  | "settings"
  | "integrations"
  | "daemon"
  | "daemonNote"
  | "slack"
  | "sessions"
  | "sessionsLoaded"
  | "fleet"
  | "fleetLoaded"
  | "repos"
  | "overrides"
  | "commands"
  | "running"
  | "attention"
  | "sessionAttention"
  | "usage"
  | "automations"
  | "sessionFilter"
  | "setSessionFilter"
  | "authStatus"
>;

export function App(): JSX.Element {
  const s = useStore(
    useShallow(
      (st): AppSelected => ({
        overlay: st.overlay,
        showRepos: st.showRepos,
        activeSessionId: st.activeSessionId,
        activeWorkerId: st.activeWorkerId,
        navBack: st.navBack,
        navFwd: st.navFwd,
        navigate: st.navigate,
        goBack: st.goBack,
        goForward: st.goForward,
        settings: st.settings,
        daemon: st.daemon,
        daemonNote: st.daemonNote,
        slack: st.slack,
        sessions: st.sessions,
        sessionsLoaded: st.sessionsLoaded,
        fleet: st.fleet,
        fleetLoaded: st.fleetLoaded,
        repos: st.repos,
        overrides: st.overrides,
        commands: st.commands,
        running: st.running,
        attention: st.attention,
        sessionAttention: st.sessionAttention,
        usage: st.usage,
        integrations: st.integrations,
        authStatus: st.authStatus,
        automations: st.automations,
        sessionFilter: st.sessionFilter,
        setSessionFilter: st.setSessionFilter,
      }),
    ),
  );
  // Location is a single store model — overlay/showRepos/activeSessionId/activeWorkerId together form one Location.
  // Transitions go through navigate; back/forward through goBack/goForward (browser-style history). A new page = add an Overlay member to the store.
  const { overlay, showRepos, navigate, goBack, goForward } = s;
  const gsDismissed = usePrefsStore((st) => st.gettingStartedDismissed);
  const setGsDismissed = usePrefsStore((st) => st.setGettingStartedDismissed);
  // i18n: closures like connect read the latest locale via tRef (same idiom as notifyRef).
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const canBack = s.navBack.length > 0;
  const canFwd = s.navFwd.length > 0;
  // "mission control is online" beat — flash the dot the instant it reaches up (falling edge of "not up"). Keeps led-live.
  const daemonJustUp = useJustEnded(s.daemon !== "up");
  const slackJustUp = useJustEnded(s.slack !== "up");
  const closeOverlay = () => navigate({ overlay: null });
  const [repoModal, setRepoModal] = useState(false);
  const [spawnRepo, setSpawnRepo] = useState<string | null>(null);
  const [spawnBranches, setSpawnBranches] = useState<string[]>([]);
  const [editJob, setEditJob] = useState<Automation | "new" | null>(null);
  // Daemon-restart confirmation dialog state
  const [restartConfirm, setRestartConfirm] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const doRestart = async () => { setRestarting(true); try { await window.rookery.daemon.restart(); } finally { setRestarting(false); setRestartConfirm(false); } };
  // OS notifications on/off (local). The onEvent closure always reads the latest value via ref.
  const [notifyOn, setNotifyOn] = useState(() => localStorage.getItem("rookery.notify") !== "0");
  const notifyRef = useRef(notifyOn);
  notifyRef.current = notifyOn;
  const toggleNotify = () => setNotifyOn((v) => { localStorage.setItem("rookery.notify", v ? "0" : "1"); return !v; });
  // Notification click → jump to that worker (Repos view).
  useEffect(() => window.rookery.onNotifyClick((id) => { useStore.getState().navigate({ overlay: null, showRepos: true, subId: id }); }), []);
  // Reset edit state when leaving the automation overlay — so re-entering shows the list instead of a stale form.
  useEffect(() => { if (overlay !== "automation") setEditJob(null); }, [overlay]);
  // When the spawn modal opens, load the base-branch candidates for that repo.
  useEffect(() => {
    if (!spawnRepo || !client) { setSpawnBranches([]); return; }
    let live = true; // prevent a late response from the previous repo from overwriting when spawnRepo changes
    void client.request({ type: "repo.branches", repo: spawnRepo }).then((r) => { if (live) setSpawnBranches(r.branches ?? []); }).catch(() => { if (live) setSpawnBranches([]); });
    return () => { live = false; };
  }, [spawnRepo]);
  const searchSource = (provider: "github" | "linear", query: string): Promise<SourceItem[]> =>
    client ? client.request({ type: "source.search", provider, query, repo: spawnRepo ?? undefined }).then((r) => r.items ?? []).catch(() => []) : Promise.resolve([]);
  // The terminal is tied to "the agent page you're currently viewing" — it must also factor in showRepos so sessions↔repos stay independent.
  // Page key: the worker id if viewing a worker in repos, otherwise (= sessions view) the active session id. None → null (no panel/toggle).
  const termPageKey = showRepos
    ? (s.activeWorkerId && s.fleet[s.activeWorkerId] ? s.activeWorkerId : null)
    : (s.activeSessionId ?? null);
  const activeTab = useWsStore((s) => (termPageKey ? s.byPage[termPageKey]?.activeTabId ?? "agent" : "agent"));
  // Click a filename chip on a tool card → open it as a file tab in the current page (session cwd / worker worktree). Disabled if there's no page.
  // Stable per page (memo effect). No page → undefined (preserves the "file-open disabled" meaning).
  const openFile = useCallback((path: string) => { const k = termPageKey; if (k) useWsStore.getState().openFile_(k, path); }, [termPageKey]);
  const openFileInPage = termPageKey ? openFile : undefined;
  const termPageOpen = useTermStore((t) => (termPageKey ? t.byPage[termPageKey]?.open ?? false : false));
  const toggleTerm = useTermStore((t) => t.toggleOpen_);
  const rightOpen = useWsStore((s) => s.right.open);
  const toggleRight = useWsStore((s) => s.toggleRight_);
  // Right sidebar: delay unmount by 180ms so the width-collapse animation is visible on close (useMountTransition).
  const rightVisible = rightOpen && !!termPageKey && !overlay;
  const rightMounted = useMountTransition(rightVisible, 180);
  const [wsRoot, setWsRoot] = useState<string>("");
  const treeVersion = useTreeVersion(wsRoot); // fs-watch bump for the dockable files/git panels (parity with RightSidebar)
  // cwd must be in deps so that even when session.list arrives late (initially undefined→home), the root is re-resolved once cwd is filled in.
  const wsSessionCwd = s.sessions.find((x) => x.id === s.activeSessionId)?.cwd;
  useEffect(() => {
    if (!termPageKey) return;
    const subId = showRepos ? s.activeWorkerId ?? undefined : undefined;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let tries = 0;
    const tick = (): void => {
      void window.rookery.ws.resolveRoot({ subId, cwd: showRepos ? undefined : wsSessionCwd }).then((r) => {
        if (!live) return;
        setWsRoot(r);
        // A freshly created worker's worktree is built asynchronously, so if it fell back to ~, retry until the worktree exists (for the diff root).
        if (subId && !r.endsWith(subId) && tries < 15) { tries += 1; timer = setTimeout(tick, 300); }
      }).catch(() => { /* ignore */ });
    };
    tick();
    return () => { live = false; if (timer) clearTimeout(timer); };
  }, [termPageKey, showRepos, wsSessionCwd, s.activeWorkerId]);
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("rookery.sidebar") === "1");
  const toggleSidebar = () =>
    setCollapsed((v) => {
      localStorage.setItem("rookery.sidebar", v ? "0" : "1");
      return !v;
    });
  // Resource monitor: polls via IPC (resources:get). Faster when the popover is open, paused when the window is hidden.
  const [resources, setResources] = useState<ResourceSnapshot | null>(null);
  const [resOpen, setResOpen] = useState(false);
  const pollResourcesOnce = useCallback(() => {
    void window.rookery.resources.get().then(setResources).catch(() => {});
  }, []);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let live = true;
    const tick = (): void => {
      if (!live) return;
      if (document.visibilityState === "visible") pollResourcesOnce();
      timer = setTimeout(tick, resOpen ? 2000 : 4000);
    };
    tick();
    const onVis = (): void => { if (document.visibilityState === "visible") pollResourcesOnce(); };
    document.addEventListener("visibilitychange", onVis);
    return () => { live = false; if (timer) clearTimeout(timer); document.removeEventListener("visibilitychange", onVis); };
  }, [resOpen, pollResourcesOnce]);
  const leftPanel = useResizableWidth("rookery.leftWidth", 252, { min: 180, max: 440, side: "left" });
  const mounted = useRef(true);
  const restoredView = useRef(false);
  const restoredTermPages = useRef<Set<string>>(new Set());
  // Spawn one new shell in the page's working folder + register a tab (shared by restore and auto-open).
  const spawnTerminalForPage = useCallback(async (key: string, subId: string | null, cwd: string | undefined): Promise<void> => {
    const r = await window.rookery.term.create({ sessionId: key, subId: subId ?? undefined, cwd, cols: 80, rows: 24 });
    if (r.id) useTermStore.getState().open_(key, { id: r.id, title: cwd ? baseName(cwd) || "zsh" : "zsh", exited: false });
  }, []);
  // Terminal toggle: on closed→open with no tabs, immediately spawn one terminal (skip the empty-drawer + ＋ step).
  const onToggleTerm = (): void => {
    if (!termPageKey) return;
    const cur = useTermStore.getState().byPage[termPageKey];
    const wasOpen = cur?.open ?? false;
    toggleTerm(termPageKey);
    if (!wasOpen && (cur?.tabs.length ?? 0) === 0) {
      void spawnTerminalForPage(termPageKey, showRepos ? s.activeWorkerId : null, showRepos ? undefined : wsSessionCwd);
    }
  };

  // Save the viewing location: write to localStorage when showRepos/activeSession/activeSub change.
  // Don't write before restore (restoredView) — otherwise the mount-time initial values (false/null/null) overwrite the saved values,
  // and the restore effect just below reads empty values and is defeated (SAVE runs before RESTORE).
  useEffect(() => {
    if (!restoredView.current) return;
    writeViewState({ showRepos, sessionId: s.activeSessionId, subId: s.activeWorkerId });
  }, [showRepos, s.activeSessionId, s.activeWorkerId]);

  // Restore the viewing location + prune dead workspace tabs: apply once after **both** the session and fleet lists arrive.
  // (Acting on just one means that when fleet arrives late, known lacks the worker keys and the whole worker page gets pruned.)
  useEffect(() => {
    if (restoredView.current) return;
    if (s.daemon !== "up") return;
    if (!s.sessionsLoaded || !s.fleetLoaded) return; // wait until both lists have arrived
    restoredView.current = true;
    const known = new Set<string>([...s.sessions.map((x) => x.id), ...Object.keys(s.fleet)]);
    // Prune dead pages (workspace tabs and composer drafts).
    useWsStore.setState((w) => pruneWsPages(w, known));
    useTermStore.setState((t) => pruneLayout(t, known));
    useDraftStore.setState((d) => pruneDrafts(d, known));
    useLayoutStore.getState().prune_(known); // dockable-panes: drop layouts for dead pages
    // Restore the viewing location — only what still exists. Restore only sets the location, so we must also seed that conversation's transcript
    // (otherwise on first run the restored worker/session conversation pane looks empty until you click it again (selectSub)).
    const v = readViewState();
    if (!v) return;
    if (v.subId && s.fleet[v.subId]) {
      const subId = v.subId;
      useStore.getState().restoreLocation({ overlay: null, showRepos: true, sessionId: null, subId });
      void client?.request({ type: "worker.history", id: subId }).then((r) => useStore.getState().seedWorkerHistory(subId, r.events ?? [])).catch(() => {});
    } else if (v.sessionId && s.sessions.some((x) => x.id === v.sessionId)) {
      const sessionId = v.sessionId;
      useStore.getState().restoreLocation({ overlay: null, showRepos: v.showRepos, sessionId, subId: null });
      void client?.request({ type: "session.history", sessionId }).then((r) => useStore.getState().seedHistory(sessionId, r.events ?? [])).catch(() => {});
    }
  }, [s.daemon, s.sessionsLoaded, s.fleetLoaded]);

  // When the active conversation pane changes, prefetch and cache that context's slash command/skill candidates (for / autocomplete).
  useEffect(() => {
    const c = client;
    if (s.daemon !== "up" || !c) return;
    let msg: { type: "commands.list"; workerId?: string; cwd?: string } | null = null;
    if (s.activeWorkerId) msg = { type: "commands.list", workerId: s.activeWorkerId };
    else if (s.activeSessionId) {
      const cwd = s.sessions.find((x) => x.id === s.activeSessionId)?.cwd;
      if (cwd) msg = { type: "commands.list", cwd };
    }
    if (!msg) { useStore.getState().setCommands([]); return; }
    let live = true; // prevent a late commands response from the previous context from overwriting when switching conversation panes
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void c.request(msg).then((r) => { if (live) useStore.getState().setCommands(r.commands ?? []); }).catch(() => {});
    return () => { live = false; };
  }, [s.activeSessionId, s.activeWorkerId, s.daemon]);

  // On page switch / renderer reload, sync that page with main's actual terminal list → restore live PTY tabs.
  // If there's no PTY after a restart, spawn new shells matching the saved layout (once per page).
  useEffect(() => {
    if (!termPageKey) return;
    const key = termPageKey;
    const subId = showRepos ? s.activeWorkerId : null;
    const cwd = showRepos ? undefined : wsSessionCwd;
    // Restore once per page: claim it synchronously *before* the await (if has return; add; await).
    // Otherwise the effect re-runs for the same key during the term.list await and double-spawns shells matching the layout.
    if (restoredTermPages.current.has(key)) return;
    restoredTermPages.current.add(key);
    void window.rookery.term.list(key).then((live) => {
      if (live.length > 0) { useTermStore.getState().setTabs_(key, live); return; } // reload: reconnect to live PTYs
      // Restore after exit: spawn new shells matching the saved layout.
      const lay = useTermStore.getState().layout[key];
      if (!lay || lay.count <= 0) return;
      void (async () => {
        for (let i = 0; i < lay.count; i++) await spawnTerminalForPage(key, subId, cwd);
        if (lay.open) useTermStore.getState().setOpen_(key, true);
      })();
    });
  }, [termPageKey]);
  const connect = useCallback(async () => {
    mounted.current = true;
    if (startTimer) clearTimeout(startTimer); // clear the previous connect's stale fallback timer (DSK-10)
    useStore.getState().setDaemon("starting");
    const status = await window.rookery.daemon.ensure();
    if (!mounted.current) return;
    if (status === "bad-node") {
      useStore.getState().setDaemonNote(tRef.current("app.badNode"));
      useStore.getState().setDaemon("down");
      return;
    }
    if (status === "failed") {
      useStore.getState().setDaemonNote(null);
      useStore.getState().setDaemon("down");
      return;
    }
    const url = await window.rookery.wsUrl();
    if (!mounted.current) return;
    client?.stop();
    const c = new WsClient(
      () => new WebSocket(url) as unknown as SocketLike,
      (e) => {
        // OS notification: read prev first at the moment of the status transition (before applyEvent). Suppressed when main is focused.
        if (e.type === "worker.status" && notifyRef.current) {
          const row = useStore.getState().fleet[e.workerId];
          const n = notifyFor(row?.status, e.status, row?.label ?? e.workerId, tRef.current);
          if (n) void window.rookery.notify({ ...n, workerId: e.workerId });
        }
        useStore.getState().applyEvent(e);
        if (e.type === "automation.changed") { void c.request({ type: "automation.list" }).then((r) => useStore.getState().setAutomations(r.automations ?? [])).catch(() => {}); }
        // Session activity/appearance → refresh the list. (For agent.* events that are results or for a session we don't know yet.)
        if (e.type.startsWith("master.")) {
          const sid = (e as { sessionId?: string }).sessionId;
          if (e.type === "master.result" || (sid && !useStore.getState().sessions.some((x) => x.id === sid))) {
            scheduleSessionRefresh(c);
          }
        }
        if (e.type === "worker.status" && ["failed", "stopped", "error"].includes(e.status)) {
          void c.request({ type: "fleet.list" }).then((r) => useStore.getState().setFleet(r.fleet ?? [])).catch(() => {});
        }
      },
    );
    client = c;
    c.onOpen(() => {
      if (startTimer) { clearTimeout(startTimer); startTimer = null; } // connection succeeded → release the fallback timer (DSK-10)
      useStore.getState().resetLiveInteractions(); // must precede events.subscribe: the replay repopulates the set
      useStore.getState().bumpConnectionEpoch(); // pending bubbles from before this reconnect become prunable at seed time
      useStore.getState().setDaemon("up");
      void c.request({ type: "session.list" }).then((r) => { useStore.getState().setSessions(r.sessions ?? []); useStore.getState().seedRunningFromSessions(r.sessions ?? []); }).catch(() => {});
      void c.request({ type: "fleet.list" }).then((r) => useStore.getState().setFleet(r.fleet ?? [])).catch(() => {});
      void c.request({ type: "repos.list" }).then((r) => useStore.getState().setRepos(r.repos ?? [])).catch(() => {});
      c.send({ type: "events.subscribe" }); // global channel: receive all session/fleet events
      pollUsage(c);
      void c.request({ type: "settings.get" }).then((r) => useStore.getState().setSettings(r.settings)).catch(() => {});
      void c.request({ type: "models.list" }).then((r) => useStore.getState().setModels((r.models ?? []).map((m) => ({ id: m.id, label: m.displayName })))).catch(() => {});
      void c.request({ type: "integrations.status" }).then((r) => useStore.getState().setIntegrations({ github: r.github, linear: r.linear })).catch(() => {});
      void c.request({ type: "auth.status" }).then((r) => useStore.getState().setAuthStatus(r)).catch(() => {});
      void c.request({ type: "automation.list" }).then((r) => useStore.getState().setAutomations(r.automations ?? [])).catch(() => {});
      // On reconnect, re-seed the open conversation — to prevent cards from being stuck in_progress forever due to a
      // tool-end/result lost while disconnected (the DB is the source of truth, so we re-fetch the full transcript and overwrite).
      const { activeSessionId, activeWorkerId } = useStore.getState();
      if (activeSessionId) void c.request({ type: "session.history", sessionId: activeSessionId }).then((r) => useStore.getState().seedHistory(activeSessionId, r.events ?? [])).catch(() => {});
      if (activeWorkerId) void c.request({ type: "worker.history", id: activeWorkerId }).then((r) => useStore.getState().seedWorkerHistory(activeWorkerId, r.events ?? [])).catch(() => {});
    });
    // On disconnect, drop the daemon indicator to 'starting' (back to 'up' on the reconnect's onOpen). Prevents 'up' from getting stuck.
    c.onClose(() => {
      if (!mounted.current) return;
      if (useStore.getState().daemon === "up") useStore.getState().setDaemon("starting");
    });
    c.start();
    // DSK-10: if onOpen never fires, we get stuck in 'starting' (the WS never opened + there's no auto-retry path other than 'down').
    // If still starting after a bounded wait, drop to 'down' to give the user a 'retry' (the client keeps attempting to reconnect).
    startTimer = setTimeout(() => {
      if (useStore.getState().daemon === "starting") {
        useStore.getState().setDaemonNote(tRef.current("app.daemonConnectFailed"));
        useStore.getState().setDaemon("down");
      }
    }, 8000);
  }, []);

  useEffect(() => {
    mounted.current = true;
    void connect();
    return () => {
      mounted.current = false;
      if (usageTimer) clearTimeout(usageTimer);
      if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer); // BUG-5: clear all module timers on unmount
      if (startTimer) clearTimeout(startTimer); // BUG-5 (+DSK-10 fallback timer)
      client?.stop();
      client = null;
    };
  }, [connect]);

  const select = useCallback((id: string) => {
    useStore.getState().navigate({ overlay: null, showRepos: false, sessionId: id }); // select session → sessions view / close full page
    // Live events arrive via the @all global subscription, so no separate attach is needed. Seed only the past conversation.
    void client?.request({ type: "session.history", sessionId: id }).then((r) => useStore.getState().seedHistory(id, r.events ?? [])).catch(() => {});
  }, []);
  const create = () => navigate({ overlay: "newSession" }); // open the new-session full page (mutually exclusive with settings/automation)
  const refetchSessions = useCallback(() => { void client?.request({ type: "session.list" }).then((r) => useStore.getState().setSessions(r.sessions ?? [])).catch(() => {}); }, []);
  // Rename session — refetch not needed since it updates live via the session.label event.
  // Inject reqId via request() (schema requires reqId) — the daemon replies with fleet.ack (the label reflects live via session.label; the ack is ignored).
  const renameSession = useCallback((id: string, label: string) => { void client?.request({ type: "session.rename", sessionId: id, label }).catch((e) => toast.error(tRef.current("toast.saveFailed"), String(e))); }, []);
  const archiveSession = useCallback((id: string, archived: boolean) => { void client?.request({ type: "session.archive", sessionId: id, archived }).then(refetchSessions).catch((e) => toast.error(tRef.current("toast.actionFailed"), String(e))); }, [refetchSessions]);
  const pinSession = useCallback((id: string, pinned: boolean) => { void client?.request({ type: "session.pin", sessionId: id, pinned }).then(refetchSessions).catch((e) => toast.error(tRef.current("toast.actionFailed"), String(e))); }, [refetchSessions]);
  const forkSession = useCallback((id: string) => { void client?.request({ type: "session.fork", sessionId: id }).then((r) => { refetchSessions(); useStore.getState().navigate({ overlay: null, showRepos: false, sessionId: r.sessionId }); void client?.request({ type: "session.history", sessionId: r.sessionId }).then((h) => useStore.getState().seedHistory(r.sessionId, h.events ?? [])).catch(() => {}); }).catch((e) => toast.error(tRef.current("toast.forkFailed"), String(e))); }, [refetchSessions]);
  // Use getState to remove the dependency on render state and stabilize with useCallback [] (as an event handler, getState() at call time = the existing closure value).
  const deleteSession = useCallback((id: string) => {
    // Optimistic removal — the row vanishes immediately (the refetch reconciles; restored on failure). Otherwise it lingers
    // until session.list returns and the delete reads as if it didn't register.
    if (useStore.getState().activeSessionId === id) useStore.setState({ activeSessionId: null });
    useStore.setState((st) => ({ sessions: st.sessions.filter((x) => x.id !== id) }));
    void client?.request({ type: "session.delete", sessionId: id }).then(() => {
      useLayoutStore.getState().clear_(id); // only after the daemon confirms (audit #34) — a failed delete restores the row AND keeps its layout
      refetchSessions();
    }).catch((e) => { toast.error(tRef.current("toast.deleteFailed"), String(e)); refetchSessions(); });
  }, [refetchSessions]);
  const refetchFleet = useCallback(() => { void client?.request({ type: "fleet.list" }).then((r) => useStore.getState().setFleet(r.fleet ?? [])).catch(() => {}); }, []);
  // Rename worker — updates live via the worker.label event. Archive/delete refetch fleet.list.
  const renameSub = useCallback((id: string, label: string) => { void client?.request({ type: "worker.rename", id, label }).catch((e) => toast.error(tRef.current("toast.saveFailed"), String(e))); }, []);
  const archiveSub = useCallback((id: string, archived: boolean) => { void client?.request({ type: "worker.archive", id, archived }).then(refetchFleet).catch((e) => toast.error(tRef.current("toast.actionFailed"), String(e))); }, [refetchFleet]);
  const deleteSub = useCallback((id: string) => {
    // Optimistic removal — mirrors deleteSession (refetch reconciles; restored on failure).
    if (useStore.getState().activeWorkerId === id) useStore.getState().navigate({ subId: null });
    useStore.setState((st) => { const f = { ...st.fleet }; delete f[id]; return { fleet: f }; });
    void client?.request({ type: "worker.delete", id }).then(() => {
      useLayoutStore.getState().clear_(id); // only after the daemon confirms (audit #34) — a failed delete restores the row AND keeps its layout
      refetchFleet();
    }).catch((e) => { toast.error(tRef.current("toast.deleteFailed"), String(e)); refetchFleet(); });
  }, [refetchFleet]);
  // Start a new session: create a session at cwd → (save model/effort overrides) → select → send the first turn if there's a prompt.
  const startSession = (opts: { cwd?: string; prompt?: string; model: string; effort: string }) => {
    navigate({ overlay: null });
    const c = client;
    if (!c) return;
    void c
      .request({ type: "session.create", ...(opts.cwd ? { cwd: opts.cwd } : {}) })
      .then((r) =>
        c.request({ type: "session.list" }).then((lr) => {
          useStore.getState().setSessions(lr.sessions ?? []);
          const sid = r.sessionId;
          if (!sid) return;
          useStore.getState().setOverride(sid, { model: opts.model, effort: opts.effort }); // subsequent turns use the same model/effort
          select(sid);
          const prompt = opts.prompt?.trim();
          if (prompt) {
            // select is async, so we can't rely on send()'s activeSessionId → send explicitly with the new sid. The pending bubble immediately shows "in progress".
            const clientMsgId = crypto.randomUUID();
            useStore.getState().pushPending(sid, { clientMsgId, text: prompt });
            // request(): a rejected send rolls the pending bubble back and surfaces a toast instead of silently stranding it.
            void c.request({ type: "session.send", sessionId: sid, text: prompt, model: opts.model, effort: opts.effort, clientMsgId }).catch((e) => {
              useStore.getState().dropPending(sid, clientMsgId);
              toast.error(tRef.current("toast.sendFailed"), String(e));
            });
          }
        }),
      )
      .catch((e) => toast.error(tRef.current("toast.actionFailed"), String(e)));
  };
  const send = useCallback((text: string) => {
    const st = useStore.getState();
    const sid = st.activeSessionId;
    if (!sid) return;
    if (st.sessions.find((x) => x.id === sid)?.origin === "slack") return; // Slack sessions are read-only in the UI
    const clientMsgId = crypto.randomUUID();
    st.pushPending(sid, { clientMsgId, text }); // pending bubble: immediately "in progress" (stop button) → switches to committed when the daemon's user echo arrives
    const ov = st.overrides[sid] ?? {}; // per-session override (backend uses defaults if absent)
    // request(): a rejected send (unknown session, runTurn throw, disconnected) rolls the pending bubble back and surfaces a toast —
    // fire-and-forget used to drop the daemon's error frame (no reqId) and the message silently vanished while the composer stayed stuck busy.
    void client?.request({ type: "session.send", sessionId: sid, text, model: ov.model, effort: ov.effort, permissionMode: ov.permissionMode as "default" | "acceptEdits" | "bypassPermissions" | "plan" | undefined, clientMsgId }).catch((e) => {
      useStore.getState().dropPending(sid, clientMsgId);
      toast.error(tRef.current("toast.sendFailed"), String(e));
    });
  }, []);
  // Stop the in-progress master turn. The backend aborts+interrupts and emits a "stopped" notice.
  // The stop button disappears when running clears via master.status:idle (server authority) — no optimistic immediate release needed.
  const stopMaster = useCallback(() => {
    const sid = useStore.getState().activeSessionId;
    if (!sid) return;
    client?.send({ type: "session.stop", sessionId: sid });
  }, []);

  // Approval/AskUserQuestion card response → resolve the pending master canUseTool (the UI updates via the interaction.resolved event).
  const respondInteraction = useCallback((requestId: string, res: { decision?: "allow" | "deny"; answers?: Record<string, string | string[]> }) => {
    client?.send({ type: "interaction.respond", requestId, decision: res.decision, answers: res.answers });
  }, []);

  const selectSub = useCallback((id: string) => {
    useStore.getState().navigate({ overlay: null, showRepos: true, subId: id });
    void client?.request({ type: "worker.history", id }).then((r) => useStore.getState().seedWorkerHistory(id, r.events ?? [])).catch(() => {});
  }, []);
  const forkSub = useCallback((id: string) => { void client?.request({ type: "worker.fork", id }).then((r) => { refetchFleet(); selectSub(r.id); }).catch((e) => toast.error(tRef.current("toast.forkFailed"), String(e))); }, [refetchFleet, selectSub]);
  const subSend = useCallback((id: string, text: string) => {
    const clientMsgId = crypto.randomUUID();
    // Show a queued bubble immediately → after the worker finishes its current turn (boundary echo) it switches to committed and settles into place.
    useStore.getState().pushWorkerPending(id, { clientMsgId, text });
    // request(): a rejected send (mid-restore, terminated worker, disconnected) rolls the bubble back and surfaces a toast —
    // fire-and-forget used to drop the daemon's error frame (no reqId) and the message silently vanished.
    void client?.request({ type: "worker.send", id, text, clientMsgId }).catch((e) => {
      useStore.getState().dropWorkerPending(id, clientMsgId);
      toast.error(tRef.current("toast.sendFailed"), String(e));
    });
  }, []);
  const subSetModel = useCallback((id: string, model: string) => {
    const prev = useStore.getState().fleet[id]?.model;
    // Optimistic: update the fleet row model immediately (reflects the dropdown value).
    useStore.setState((st) => (st.fleet[id] ? { fleet: { ...st.fleet, [id]: { ...st.fleet[id], model } } } : {}));
    // request(): a rejected change (terminated worker, disconnected) rolls the dropdown back so it doesn't lie about the applied value.
    void client?.request({ type: "worker.setModel", id, model }).catch((e) => {
      useStore.setState((st) => (st.fleet[id] ? { fleet: { ...st.fleet, [id]: { ...st.fleet[id], model: prev } } } : {}));
      toast.error(tRef.current("toast.actionFailed"), String(e));
    });
  }, []);
  const subSetPermissionMode = useCallback((id: string, mode: string) => {
    const prev = useStore.getState().fleet[id]?.permissionMode;
    // Optimistic: reflect the dropdown value on the fleet row immediately.
    useStore.setState((st) => (st.fleet[id] ? { fleet: { ...st.fleet, [id]: { ...st.fleet[id], permissionMode: mode } } } : {}));
    // request(): a rejected change rolls the dropdown back so it doesn't lie about the applied value.
    void client?.request({ type: "worker.setPermissionMode", id, permissionMode: mode as "bypassPermissions" | "plan" }).catch((e) => {
      useStore.setState((st) => (st.fleet[id] ? { fleet: { ...st.fleet, [id]: { ...st.fleet[id], permissionMode: prev } } } : {}));
      toast.error(tRef.current("toast.actionFailed"), String(e));
    });
  }, []);
  // Interrupt the worker's current turn (keep the session) — composer stop button. The worker equivalent of the master's stopMaster.
  const subInterrupt = useCallback((id: string) => { void client?.request({ type: "worker.interrupt", id }).catch((e) => toast.error(tRef.current("toast.actionFailed"), String(e))); }, []);
  const spawnSub = (task: string, label: string, model?: string, effort?: string, base?: string, ticket?: { key: string; url: string }, permissionMode?: string) => {
    const c = client;
    if (!c || !spawnRepo) return;
    void c
      .request({ type: "fleet.spawn", repo: spawnRepo, task, label: label || spawnRepo, model, effort, base, ticketKey: ticket?.key, ticketUrl: ticket?.url, permissionMode: permissionMode as "bypassPermissions" | "plan" | undefined })
      .then((r) =>
        c.request({ type: "fleet.list" }).then((lr) => {
          useStore.getState().setFleet(lr.fleet ?? []);
          if (r.id) { selectSub(r.id); toast.success(tRef.current("toast.workerSpawned")); }
        }),
      )
      .catch((e) => toast.error(tRef.current("toast.spawnFailed"), String(e)));
  };

  const onRegister = useCallback((r: { name: string; path: string; description: string }) => {
    const c = client; if (!c) return;
    void c.request({ type: "repos.register", ...r }).then(() => c.request({ type: "repos.list" })).then((res) => { useStore.getState().setRepos(res.repos ?? []); toast.success(tRef.current("toast.repoRegistered")); }).catch((e) => toast.error(tRef.current("toast.registerFailed"), String(e)));
  }, []);
  const onRemoveRepo = useCallback((name: string) => {
    const c = client; if (!c) return;
    void c.request({ type: "repos.remove", name }).then(() => c.request({ type: "repos.list" })).then((res) => useStore.getState().setRepos(res.repos ?? [])).catch((e) => toast.error(tRef.current("toast.actionFailed"), String(e)));
  }, []);
  const onStop = useCallback((id: string) => { void client?.request({ type: "fleet.stop", id }).catch((e) => toast.error(tRef.current("toast.actionFailed"), String(e))); }, []); // RepoTree right-click 'stop'
  const onNewRepo = useCallback(() => setRepoModal(true), []);
  const onNewSub = useCallback((name: string) => setSpawnRepo(name), []);
  const fetchCheckpoints = (id: string): Promise<Checkpoint[]> =>
    client ? client.request({ type: "worker.checkpoints", id }).then((r) => r.checkpoints ?? []).catch(() => []) : Promise.resolve([]);
  const onRestore = (id: string, seq: number) => { void client?.request({ type: "worker.restore", id, seq }).catch((e) => toast.error(tRef.current("toast.actionFailed"), String(e))); };
  const saveSettings = useCallback((next: SettingsValues) => {
    const c = client; if (!c) return;
    void c.request({ type: "settings.set", settings: next }).then((r) => { useStore.getState().setSettings(r.settings); }).catch((e) => toast.error(tRef.current("toast.saveFailed"), String(e)));
  }, []);
  // Composer attach/drop — reads only the window bridge for stability (avoids a new ref every render → Conversation memo effect).
  const onAttachFile = useCallback(() => window.rookery.pickFile(), []);
  const onDropFiles = useCallback((files: File[]) => files.map((f) => window.rookery.getPathForFile(f)).filter(Boolean), []);
  // @ path autocomplete: list directories relative to the active page's work root (worker worktree > session cwd > home).
  // Isomorphic to the commands.list context injection — subId for a worker page, cwd for a master session.
  const browseDir = useCallback(
    (dir: string) => window.rookery.fs.browse(showRepos ? { dir, subId: s.activeWorkerId ?? undefined } : { dir, cwd: wsSessionCwd }),
    [showRepos, s.activeWorkerId, wsSessionCwd],
  );
  // For the new-session composer — since cwd is chosen below the input, take cwd as an argument and resolve @·/ live relative to that repo.
  const newSessionBrowse = useCallback((dir: string, cwd?: string) => window.rookery.fs.browse({ dir, cwd }), []);
  const loadNewSessionCommands = useCallback(
    (cwd?: string): Promise<SlashCommand[]> =>
      client ? client.request({ type: "commands.list", cwd }).then((r) => r.commands ?? []).catch(() => []) : Promise.resolve([]),
    [client],
  );

  const activeSub = s.activeWorkerId ? s.fleet[s.activeWorkerId] : undefined;
  const fleet = useMemo(() => Object.values(s.fleet), [s.fleet]); // used in RepoTree (Repos view)
  // Master composer model/effort controls — inline would be a new ref every render, breaking the Conversation memo. Keep the same ref
  // across unrelated re-renders like usage polling (deps: settings/active session/overrides only).
  const masterControls = useMemo(
    () =>
      s.settings && s.activeSessionId
        ? {
            model: s.overrides[s.activeSessionId]?.model ?? s.settings.masterModel,
            effort: s.overrides[s.activeSessionId]?.effort ?? s.settings.masterEffort,
            permissionMode: s.overrides[s.activeSessionId]?.permissionMode ?? "bypassPermissions",
            editable: true,
            onModel: (m: string) => useStore.getState().setOverride(useStore.getState().activeSessionId!, { model: m }),
            onEffort: (e: string) => useStore.getState().setOverride(useStore.getState().activeSessionId!, { effort: e }),
            onPermissionMode: (m: string) => useStore.getState().setOverride(useStore.getState().activeSessionId!, { permissionMode: m }),
          }
        : undefined,
    [s.settings, s.activeSessionId, s.overrides],
  );
  const activeSess = s.activeSessionId ? s.sessions.find((x) => x.id === s.activeSessionId) : undefined;
  const sessionName = activeSess ? activeSess.label || baseName(activeSess.cwd) || "session" : t("app.selectSession");
  const sessionReadOnly = (s.activeSessionId ? s.sessions.find((x) => x.id === s.activeSessionId)?.origin : undefined) === "slack";

  // Dockable-panes workspace (feature-flagged: rookery.dockable). The render
  // delegates reuse the exact per-page wiring from the static layout below, so
  // behavior is preserved; the dockview panels pull them via WorkspaceRender context.
  const dockable = isDockableEnabled();
  const activeTabPath = activeTab.startsWith("file:") ? activeTab.slice("file:".length) : null;
  const findingWorkDir = <div className="px-3 py-3 text-[12px] text-muted">{t("rightSidebar.findingWorkDir")}</div>;
  const workerRender: WorkspaceRender | null = activeSub
    ? {
        conversation: () => (
          <ConversationPane
            key={activeSub.id}
            kind="worker"
            id={activeSub.id}
            onSend={(text) => subSend(activeSub.id, text)}
            onStop={() => subInterrupt(activeSub.id)}
            onOpenFile={openFileInPage}
            onAttachFile={onAttachFile}
            onDropFiles={onDropFiles}
            browseDir={browseDir}
            commands={s.commands}
            controls={{
              model: activeSub.model ?? s.settings?.workerModel ?? "claude-opus-4-8",
              editable: activeSub.status === "running" || activeSub.status === "idle",
              onModel: (m) => subSetModel(activeSub.id, m),
              permissionMode: activeSub.permissionMode ?? "bypassPermissions",
              onPermissionMode: (m) => subSetPermissionMode(activeSub.id, m),
              permissionModes: ["bypassPermissions", "plan"] as const,
            }}
            disabled={activeSub.status !== "running" && activeSub.status !== "idle"}
            placeholder={
              activeSub.status === "provisioning"
                ? t("app.creatingWorktree")
                : activeSub.status === "running"
                  ? t("app.busyAddable")
                  : activeSub.status === "idle"
                    ? t("app.instructWorker")
                    : activeSub.status === "orphaned"
                      ? t("app.sessionEndedRestart")
                      : t("app.agentEndedReadonly")
            }
          />
        ),
        editor: (tabId) => <WorkspaceTab activeTab={tabId} pageKey={activeSub.id} root={wsRoot} />,
        terminal: () => <TerminalPanel sessionId={activeSub.id} subId={activeSub.id} cwd={undefined} dock />,
        files: () => (wsRoot && wsRoot.endsWith(activeSub.id) ? <FileTree root={wsRoot} pageKey={activeSub.id} version={treeVersion} activeTabPath={activeTabPath} /> : findingWorkDir),
        git: () => (wsRoot && wsRoot.endsWith(activeSub.id) ? <GitChanges root={wsRoot} pageKey={activeSub.id} version={treeVersion} /> : findingWorkDir),
        nested: () => <NestedPanelBody subId={activeSub.id} />,
      }
    : null;
  const masterRender: WorkspaceRender | null = s.activeSessionId
    ? {
        conversation: () => (
          <ConversationPane
            key={s.activeSessionId ?? "none"}
            kind="master"
            id={s.activeSessionId!}
            onSend={send}
            onOpenFile={openFileInPage}
            onSelectWorker={selectSub}
            onRespond={respondInteraction}
            disabled={sessionReadOnly}
            onStop={stopMaster}
            placeholder={sessionReadOnly ? t("app.slackReadOnly") : t("app.composerPlaceholder")}
            onAttachFile={onAttachFile}
            onDropFiles={onDropFiles}
            browseDir={browseDir}
            commands={s.commands}
            controls={masterControls}
          />
        ),
        editor: (tabId) => <WorkspaceTab activeTab={tabId} pageKey={s.activeSessionId!} root={wsRoot} />,
        terminal: () => <TerminalPanel sessionId={s.activeSessionId!} subId={null} cwd={activeSess?.cwd} dock />,
        files: () => (wsRoot ? <FileTree root={wsRoot} pageKey={s.activeSessionId!} version={treeVersion} activeTabPath={activeTabPath} /> : findingWorkDir),
        git: () => (wsRoot ? <GitChanges root={wsRoot} pageKey={s.activeSessionId!} version={treeVersion} /> : findingWorkDir),
        nested: () => <NestedPanelBody subId={null} />,
      }
    : null;

  const navBtn = (label: string, active: boolean, onClick: () => void, badge = false) => (
    <button
      onClick={onClick}
      className={cn(
        "no-drag relative rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors",
        active ? "bg-raised text-fg" : "text-muted hover:bg-raised/60 hover:text-fg-dim",
      )}
    >
      {label}
      {/* dot on the Repos tab when there's an unread worker — so even in the Sessions view you notice "something finished". */}
      {badge && <span className="badge-pop absolute -right-0.5 top-0.5 h-1.5 w-1.5 rounded-full bg-run" />}
    </button>
  );

  // Main-area page/overlay swap identifier — the key for replaying rise-in. ⚠️ Derive it only from Location fields (overlay/showRepos/active*).
  // Including high-frequency fields like token/usage/metrics would replay enter on every in-page stream tick,
  // which is worse than static. TerminalPanel sits outside this wrapper (protects the live xterm).
  const pageId = overlay
    ? `ov:${overlay}`
    : s.daemon === "down"
      ? "daemon-down"
      : showRepos
        ? `w:${s.activeWorkerId ?? "none"}`
        : `s:${s.activeSessionId ?? "none"}`;

  return (
    <div className="app-top-inset relative flex h-screen overflow-hidden bg-ink text-fg">
      <WindowControls />
      <aside
        style={collapsed ? undefined : { width: leftPanel.width }}
        className={cn(
          "sidebar-top relative flex shrink-0 flex-col border-r border-line bg-surface pt-10",
          leftPanel.resizing ? "" : "transition-all duration-200",
          collapsed ? "w-14 items-center gap-2" : "gap-3 px-3 pb-3",
        )}
      >
        {/* the top traffic-light area (pt-10) is a window-move drag region (macOS). On Windows/Linux the dedicated
            title bar handles this, so .win-chrome hides this strip + shrinks the pt (globals.css). */}
        <div className="mac-drag-strip drag absolute inset-x-0 top-0 h-10" />
        {!collapsed && (
          <div className="absolute right-2 top-2 z-20 flex items-center gap-1.5">
            <button
              onClick={toggleNotify}
              aria-label={notifyOn ? t("app.notifyOnTitle") : t("app.notifyOffTitle")}
              title={notifyOn ? t("app.notifyOnTitle") : t("app.notifyOffTitle")}
              className={cn("no-drag flex h-7 w-7 items-center justify-center rounded-md border border-line bg-ink/40 transition-colors hover:bg-raised", notifyOn ? "text-fg-dim" : "text-muted")}
            >
              {notifyOn ? <Bell size={13} /> : <BellOff size={13} />}
            </button>
            <ResourceMonitor snapshot={resources} onRefresh={pollResourcesOnce} onOpenChange={setResOpen} />
          </div>
        )}
        {collapsed ? (
          <>
            <button
              onClick={toggleSidebar}
              aria-label={t("app.expandSidebar")}
              title={t("app.expandSidebar")}
              className="no-drag rounded-md p-1.5 text-muted hover:bg-raised hover:text-fg-dim"
            >
              <PanelLeft size={16} />
            </button>
            <button
              onClick={goBack}
              disabled={!canBack}
              aria-label={t("app.back")}
              title={t("app.back")}
              className="no-drag rounded-md p-1.5 text-muted enabled:hover:bg-raised enabled:hover:text-fg-dim disabled:opacity-25"
            >
              <ChevronLeft size={16} />
            </button>
            <button
              onClick={goForward}
              disabled={!canFwd}
              aria-label={t("app.forward")}
              title={t("app.forward")}
              className="no-drag rounded-md p-1.5 text-muted enabled:hover:bg-raised enabled:hover:text-fg-dim disabled:opacity-25"
            >
              <ChevronRight size={16} />
            </button>
            <ResourceMonitor snapshot={resources} collapsed onRefresh={pollResourcesOnce} onOpenChange={setResOpen} />
            <button onClick={toggleNotify} aria-label={notifyOn ? t("app.notifyOff") : t("app.notifyOn")} title={notifyOn ? t("app.notifyOff") : t("app.notifyOn")} className="no-drag mt-auto rounded-md p-1.5 text-muted hover:bg-raised hover:text-fg-dim">
              {notifyOn ? <Bell size={16} /> : <BellOff size={16} />}
            </button>
            <Tooltip label={t("app.restartDaemon")} side="right">
              <button onClick={() => setRestartConfirm(true)} disabled={restarting} aria-label={t("app.restartDaemon")} className="no-drag rounded-md p-1.5 text-muted hover:bg-raised hover:text-fg-dim disabled:opacity-40">
                <RotateCcw size={16} className={cn(restarting && "animate-spin")} />
              </button>
            </Tooltip>
            <Tooltip label={t("app.settings")} side="right">
              <button onClick={() => { navigate({ overlay: overlay === "settings" ? null : "settings" }); }} aria-label={t("app.settings")} className={cn("no-drag mb-1 rounded-md p-1.5 transition-colors", overlay === "settings" ? "bg-accent/15 text-accent" : "text-muted hover:bg-raised hover:text-fg-dim")}>
                <Settings size={16} />
              </button>
            </Tooltip>
          </>
        ) : (
          <>
            <div className="drag flex items-center gap-1 px-0.5">
              {navBtn(t("app.navSessions"), !showRepos && !overlay, () => { navigate({ overlay: null, showRepos: false }); }, Object.values(s.sessionAttention).some(Boolean))}
              {navBtn(t("app.navRepos"), showRepos && !overlay, () => { navigate({ overlay: null, showRepos: true }); }, Object.values(s.attention).some(Boolean))}
              <div className="no-drag ml-auto flex items-center gap-0.5">
                <button onClick={goBack} disabled={!canBack} aria-label={t("app.back")} title={t("app.back")} className="rounded-md p-1 text-muted enabled:hover:bg-raised enabled:hover:text-fg-dim disabled:opacity-25">
                  <ChevronLeft size={16} />
                </button>
                <button onClick={goForward} disabled={!canFwd} aria-label={t("app.forward")} title={t("app.forward")} className="rounded-md p-1 text-muted enabled:hover:bg-raised enabled:hover:text-fg-dim disabled:opacity-25">
                  <ChevronRight size={16} />
                </button>
                <button onClick={toggleSidebar} aria-label={t("app.collapseSidebar")} title={t("app.collapseSidebar")} className="rounded-md p-1 text-muted hover:bg-raised hover:text-fg-dim">
                  <PanelLeftClose size={15} />
                </button>
              </div>
            </div>
            {/* Sessions view only: quick entry right below the tabs — new session + automation. (replaces the bottom buttons) */}
            {!showRepos && (
              <div className="flex flex-col">
                <button
                  onClick={create}
                  className={cn("no-drag flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors", overlay === "newSession" ? "bg-accent/15 text-accent" : "text-fg-dim hover:bg-raised hover:text-fg")}
                >
                  <Plus size={15} className="shrink-0" /> {t("app.newSession")}
                </button>
                <button
                  onClick={() => { navigate({ overlay: "automation" }); }}
                  className={cn("no-drag flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-[13px] font-medium transition-colors", overlay === "automation" ? "bg-accent/15 text-accent" : "text-fg-dim hover:bg-raised hover:text-fg")}
                >
                  <Clock size={15} className="shrink-0" /> {t("app.automation")}
                </button>
              </div>
            )}
            {showRepos ? (
              <RepoTree repos={s.repos} fleet={fleet} loaded={s.fleetLoaded} activeSubId={overlay ? null : s.activeWorkerId} onSelectSub={selectSub} onNewRepo={onNewRepo} onRemoveRepo={onRemoveRepo} onNewSub={onNewSub} attention={s.attention} onStopSub={onStop} onRenameSub={renameSub} onForkSub={forkSub} onArchiveSub={archiveSub} onDeleteSub={deleteSub} />
            ) : (
              <Sessions sessions={s.sessions} loaded={s.sessionsLoaded} activeId={overlay ? null : s.activeSessionId} running={s.running} attention={s.sessionAttention} onSelect={select} onRename={renameSession} onFork={forkSession} onArchive={archiveSession} onDelete={deleteSession} onPin={pinSession} automations={s.automations} filter={s.sessionFilter} onFilter={s.setSessionFilter} />
            )}
            <UsagePanel usage={s.usage} />
            {/* daemon·Slack status + settings gear. Normally just dot+name (clean), appending · status only when not up. Exact status in the tooltip. */}
            <div className="flex items-center gap-3 px-1 py-0.5 font-mono text-[11px] text-muted">
              <span className="flex items-center gap-1.5" title={`daemon · ${s.daemon}`}>
                <span className={cn("h-1.5 w-1.5 rounded-full transition-colors duration-200", s.daemon === "up" ? "bg-pr led-live" : s.daemon === "starting" ? "bg-run led-live" : "bg-fail", daemonJustUp && "status-flash")} />
                <span>daemon{s.daemon !== "up" && <span className="text-fg-dim"> · {s.daemon}</span>}</span>
              </span>
              <span className="flex items-center gap-1.5" title={`slack · ${s.slack}`}>
                <span className={cn("h-1.5 w-1.5 rounded-full transition-colors duration-200", s.slack === "up" ? "bg-pr led-live" : s.slack === "connecting" ? "bg-run led-live" : s.slack === "error" ? "bg-fail" : "bg-stop", slackJustUp && "status-flash")} />
                <span>slack{s.slack !== "up" && <span className="text-fg-dim"> · {s.slack}</span>}</span>
              </span>
              <Tooltip label={t("app.restartDaemon")} side="top">
                <button onClick={() => setRestartConfirm(true)} disabled={restarting} aria-label={t("app.restartDaemon")} className="no-drag ml-auto flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-raised hover:text-fg-dim disabled:opacity-40">
                  <RotateCcw size={13} className={cn(restarting && "animate-spin")} />
                </button>
              </Tooltip>
              <Tooltip label={t("app.settings")} side="top">
                <button onClick={() => { navigate({ overlay: overlay === "settings" ? null : "settings" }); }} aria-label={t("app.settings")} className={cn("no-drag flex h-6 w-6 items-center justify-center rounded-md transition-colors", overlay === "settings" ? "bg-accent/15 text-accent" : "text-muted hover:bg-raised hover:text-fg-dim")}>
                  <Settings size={14} />
                </button>
              </Tooltip>
            </div>
          </>
        )}
      </aside>
      {!collapsed && <ResizeHandle onPointerDown={leftPanel.startDrag} />}

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-ink">
        {/* The WS dropped (e.g. daemon restart) — the live stream is dead and won't resume until reconnect, so an in-progress
            bubble sits frozen. This strip says "reconnecting" so that reads as a transient reconnect, not a hang. Hidden once up;
            replaced by DaemonDownBanner if it ultimately fails (→ 'down'). */}
        {s.daemon === "starting" && (
          <div className="flex shrink-0 items-center justify-center gap-1.5 border-b border-run/30 bg-run/10 px-3 py-1.5 text-[11px] font-medium text-run">
            <Loader2 size={12} className="animate-spin" /> {t("app.reconnecting")}
          </div>
        )}
        {/* replay rise-in on every page/overlay swap (key=pageId). Keep TerminalPanel outside this div to preserve the xterm. */}
        <div key={pageId} className="flex min-h-0 flex-1 flex-col rise-in">
        {overlay === "settings" && s.settings ? (
          <SettingsPage
            settings={s.settings}
            onSave={saveSettings}
            onClose={closeOverlay}
            slack={s.slack}
            onSlackToggle={(enabled) => { void client?.request({ type: "slack.set", enabled }); }}
            integrations={s.integrations}
            authStatus={s.authStatus}
            onSaveLinearKey={(key) => {
              void client?.request({ type: "settings.set", settings: { linearApiKey: key } })
                .then(() => client?.request({ type: "integrations.status" }))
                .then((r) => { if (r) useStore.getState().setIntegrations({ github: r.github, linear: r.linear }); })
                .catch((e) => toast.error(tRef.current("toast.saveFailed"), String(e)));
            }}
            onSaveSlackTokens={(bot, app) => { void client?.request({ type: "settings.set", settings: { slackBotToken: bot, slackAppToken: app } }).catch((e) => toast.error(tRef.current("toast.saveFailed"), String(e))); }}
            onSaveAnthropicKey={(key) => { void client?.request({ type: "settings.set", settings: { anthropicApiKey: key } }).catch((e) => toast.error(tRef.current("toast.saveFailed"), String(e))); }}
          />
        ) : overlay === "newSession" ? (
          <NewSessionPage repos={s.repos} defaultModel={s.settings?.masterModel ?? "claude-opus-4-8"} defaultEffort={s.settings?.masterEffort ?? "high"} onStart={startSession} onClose={closeOverlay} browseDir={newSessionBrowse} loadCommands={loadNewSessionCommands} onAttachFile={onAttachFile} onDropFiles={onDropFiles} authStatus={s.authStatus} onOpenSettings={() => navigate({ overlay: "settings" })} defaultFolder={s.settings?.defaultSessionCwd} />
        ) : overlay === "automation" ? (
          editJob ? (
            <AutomationForm
              job={editJob}
              repos={s.repos}
              commands={s.commands}
              browseDir={newSessionBrowse}
              onClose={() => setEditJob(null)}
              onSubmit={async (input) => {
                const msg =
                  editJob === "new"
                    ? ({ type: "automation.create" as const, automation: input })
                    : ({ type: "automation.update" as const, id: editJob.id, patch: input });
                try {
                  await client?.request(msg);
                  setEditJob(null);
                } catch (e) {
                  toast.error(tRef.current("toast.automationFailed"), String(e));
                }
              }}
            />
          ) : (
            <AutomationPage
              onClose={closeOverlay}
              automations={s.automations}
              onRun={(id, vars) => {
                // The request resolves only when the run finishes (runNow awaits the action), so AutomationPage keeps the Play
                // button spinning until then (feedback + double-fire block); we toast either way. Always resolves so the spinner clears.
                const req = client?.request({ type: "automation.run", id, ...(vars ? { vars } : {}) });
                return req ? req.then(() => { toast.success(tRef.current("toast.automationRan")); }, (e) => { toast.error(tRef.current("toast.automationFailed"), String(e)); }) : Promise.resolve();
              }}
              onToggle={(id, enabled) => {
                const req = client?.request({ type: "automation.set_enabled", id, enabled });
                return req ? req.then(() => {}, (e) => { toast.error(tRef.current("toast.actionFailed"), String(e)); throw e; }) : Promise.resolve(); // rethrow → AutomationPage reverts the optimistic toggle
              }}
              onDelete={(id) => { void client?.request({ type: "automation.delete", id }).catch((e) => toast.error(tRef.current("toast.deleteFailed"), String(e))); }}
              onEdit={(job) => setEditJob(job)}
              onNew={() => setEditJob("new")}
              onViewSessions={(id) => { s.setSessionFilter({ source: "automation", automationId: id }); navigate({ overlay: null, showRepos: false }); }}
            />
          )
        ) : s.daemon === "down" ? (
          <DaemonDownBanner note={s.daemonNote} onRetry={() => void connect()} />
        ) : showRepos ? (
          activeSub ? (
            dockable && workerRender ? (
              <div className="flex min-h-0 flex-1 flex-col">
                <WorkerHeader
                  worker={activeSub}
                  termPageKey={termPageKey}
                  termPageOpen={false}
                  rightOpen={false}
                  onToggleTerm={() => {}}
                  onToggleRight={() => {}}
                  onFetchCheckpoints={() => fetchCheckpoints(activeSub.id)}
                  onRestore={(seq) => onRestore(activeSub.id, seq)}
                  dock
                />
                <WorkspaceRenderProvider value={workerRender}>
                  <WorkspaceDock key={activeSub.id} pageKey={activeSub.id} agentKind="worker" />
                </WorkspaceRenderProvider>
              </div>
            ) : (
            <>
              <WorkerHeader
                worker={activeSub}
                termPageKey={termPageKey}
                termPageOpen={termPageOpen}
                rightOpen={rightOpen}
                onToggleTerm={onToggleTerm}
                onToggleRight={toggleRight}
                onFetchCheckpoints={() => fetchCheckpoints(activeSub.id)}
                onRestore={(seq) => onRestore(activeSub.id, seq)}
              />
              <div className="flex min-h-0 flex-1">
                <div className="flex min-w-0 flex-1 flex-col">
                  {termPageKey && <TabBar pageKey={termPageKey} agentLabel={showRepos ? t("app.worker") : t("app.master")} />}
                  {activeTab === "agent" ? (
                    <ConversationPane
                      key={activeSub.id}
                      kind="worker"
                      id={activeSub.id}
                      onSend={(t) => subSend(activeSub.id, t)}
                      onStop={() => subInterrupt(activeSub.id)}
                      onOpenFile={openFileInPage}
                      onAttachFile={onAttachFile}
                      onDropFiles={onDropFiles}
                      browseDir={browseDir}
                      commands={s.commands}
                      controls={{
                        // while running, the model + permission mode can be changed live (query.setModel / query.setPermissionMode). effort can't → omitted.
                        model: activeSub.model ?? s.settings?.workerModel ?? "claude-opus-4-8",
                        editable: activeSub.status === "running" || activeSub.status === "idle",
                        onModel: (m) => subSetModel(activeSub.id, m),
                        permissionMode: activeSub.permissionMode ?? "bypassPermissions",
                        onPermissionMode: (m) => subSetPermissionMode(activeSub.id, m),
                        permissionModes: ["bypassPermissions", "plan"] as const, // workers: only bypass + plan (no default/acceptEdits)
                      }}
                      disabled={activeSub.status !== "running" && activeSub.status !== "idle"}
                      placeholder={
                        activeSub.status === "provisioning"
                          ? t("app.creatingWorktree")
                          : activeSub.status === "running"
                            ? t("app.busyAddable")
                            : activeSub.status === "idle"
                              ? t("app.instructWorker")
                              : activeSub.status === "orphaned"
                                ? t("app.sessionEndedRestart")
                                : t("app.agentEndedReadonly")
                      }
                    />
                  ) : (
                    <WorkspaceTab activeTab={activeTab} pageKey={termPageKey!} root={wsRoot} />
                  )}
                </div>
              </div>
            </>
            )
          ) : (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-muted">
              {t("app.emptyRepoHint")}
            </div>
          )
        ) : !s.activeSessionId ? (
          // when no session is selected (first run, etc.), default to the new-session screen instead of a blank screen.
          <NewSessionPage repos={s.repos} defaultModel={s.settings?.masterModel ?? "claude-opus-4-8"} defaultEffort={s.settings?.masterEffort ?? "high"} onStart={startSession} browseDir={newSessionBrowse} loadCommands={loadNewSessionCommands} onAttachFile={onAttachFile} onDropFiles={onDropFiles} authStatus={s.authStatus} onOpenSettings={() => navigate({ overlay: "settings" })} defaultFolder={s.settings?.defaultSessionCwd} />
        ) : dockable && masterRender ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <SessionHeader
              name={sessionName}
              sessionId={s.activeSessionId}
              cwd={activeSess?.cwd}
              readOnly={sessionReadOnly}
              running={!!(s.activeSessionId && s.running[s.activeSessionId])}
              termPageKey={termPageKey}
              termPageOpen={false}
              rightOpen={false}
              onToggleTerm={() => {}}
              onToggleRight={() => {}}
              dock
            />
            <WorkspaceRenderProvider value={masterRender}>
              <WorkspaceDock key={s.activeSessionId ?? "none"} pageKey={s.activeSessionId!} agentKind="master" />
            </WorkspaceRenderProvider>
          </div>
        ) : (
          <>
            <SessionHeader
              name={sessionName}
              sessionId={s.activeSessionId}
              cwd={activeSess?.cwd}
              readOnly={sessionReadOnly}
              running={!!(s.activeSessionId && s.running[s.activeSessionId])}
              termPageKey={termPageKey}
              termPageOpen={termPageOpen}
              rightOpen={rightOpen}
              onToggleTerm={onToggleTerm}
              onToggleRight={toggleRight}
            />
            {termPageKey && <TabBar pageKey={termPageKey} agentLabel={showRepos ? t("app.worker") : t("app.master")} />}
            {activeTab === "agent" ? (
              <ConversationPane
                key={s.activeSessionId ?? "none"}
                kind="master"
                id={s.activeSessionId!}
                onSend={send}
                onOpenFile={openFileInPage}
                onSelectWorker={selectSub}
                onRespond={respondInteraction}
                disabled={sessionReadOnly}
                onStop={stopMaster}
                placeholder={sessionReadOnly ? t("app.slackReadOnly") : t("app.composerPlaceholder")}
                onAttachFile={onAttachFile}
                onDropFiles={onDropFiles}
                browseDir={browseDir}
                commands={s.commands}
                controls={masterControls}
              />
            ) : (
              <WorkspaceTab activeTab={activeTab} pageKey={termPageKey!} root={wsRoot} />
            )}
          </>
        )}
        </div>
        {termPageKey && termPageOpen && !overlay && !dockable && (
          <TerminalPanel
            sessionId={termPageKey}
            subId={showRepos ? s.activeWorkerId : null}
            cwd={showRepos ? undefined : activeSess?.cwd}
          />
        )}
      </main>
      {rightMounted && termPageKey && !dockable && (
        <RightSidebar open={rightVisible} pageKey={termPageKey} subId={showRepos ? s.activeWorkerId : null} cwd={showRepos ? undefined : activeSess?.cwd} activeTabPath={activeTab.startsWith("file:") ? activeTab.slice("file:".length) : null} />
      )}

      <Toaster />
      {restartConfirm && <RestartDaemonDialog busy={restarting} onClose={() => setRestartConfirm(false)} onConfirm={() => void doRestart()} />}
      {repoModal && <RepoModal repos={s.repos} onRegister={onRegister} onClose={() => setRepoModal(false)} />}
      {spawnRepo && (
        <WorkerSpawnModal
          repo={spawnRepo}
          defaultModel={s.settings?.workerModel ?? "claude-opus-4-8"}
          defaultEffort={s.settings?.workerEffort ?? "high"}
          branches={spawnBranches}
          integrations={s.integrations ?? undefined}
          searchSource={searchSource}
          onSpawn={spawnSub}
          onClose={() => setSpawnRepo(null)}
        />
      )}
      <DataConsentModal
        settings={s.settings}
        daemon={s.daemon}
        onAccept={() => {
          void client?.request({ type: "settings.set", settings: { hasAcceptedDataNotice: "1" } })
            .then(() => useStore.getState().setSettings({ ...useStore.getState().settings!, hasAcceptedDataNotice: "1" }))
            .catch(() => {});
        }}
      />
      {/* Onboarding (after consent, before all-set): welcome+concept modal, then a non-blocking Getting Started card. */}
      {s.daemon === "up" && s.settings && s.settings.hasAcceptedDataNotice === "1" && s.settings.onboardingDone !== "1" && (
        <OnboardingModal
          onFinish={() => {
            void client?.request({ type: "settings.set", settings: { onboardingDone: "1" } })
              .then(() => useStore.getState().setSettings({ ...useStore.getState().settings!, onboardingDone: "1" }))
              .catch(() => {});
          }}
        />
      )}
      {(() => {
        if (s.daemon !== "up" || !s.settings || s.settings.onboardingDone !== "1" || gsDismissed) return null;
        const authDone = !!s.authStatus && s.authStatus.method !== "none";
        const folderDone = !!s.settings.defaultSessionCwd;
        const sessionDone = s.sessions.length > 0;
        if (authDone && folderDone && sessionDone) return null; // all set → no nag
        return (
          <GettingStartedChecklist
            authDone={authDone}
            folderDone={folderDone}
            sessionDone={sessionDone}
            onAuth={() => navigate({ overlay: "settings" })}
            onFolder={() => { void window.rookery.pickDirectory().then((dir) => { if (dir) void client?.request({ type: "settings.set", settings: { defaultSessionCwd: dir } }).then((r) => useStore.getState().setSettings(r.settings)).catch(() => {}); }); }}
            onSession={() => create()}
            onDismiss={() => setGsDismissed(true)}
          />
        );
      })()}
    </div>
  );
}
