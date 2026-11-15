import type { ImageRef } from "@daemon/core/image-input.js";
import type { SelectedAttachment } from "./lib/image-import.js";
import { setImageClient } from "./lib/image-client.js";
import type { ComposerControls } from "./components/Composer.js";
import type { SpeedPreference } from "@daemon/core/speed.js";
import { persistSpeedPreference, type SpeedWriteState } from "./lib/speed-preference.js";
import { defaultSpeed } from "./lib/speed.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { PanelLeftClose, ChevronLeft, ChevronRight, Plus, Loader2, MessageSquare, FolderGit2, X } from "lucide-react";
import type { SettingsValues } from "@daemon/core/settings.js";
import type { ClientMessage } from "@daemon/protocol/messages.js";
import type { SourceItem } from "@daemon/core/source-intake.js";
import type { Automation } from "@daemon/persistence/repositories.js";
import type { CapabilityPreviewTarget, CapabilityTarget } from "@daemon/core/capabilities/types.js";
import type { CommandAction } from "@daemon/core/capabilities/commands.js";
import { useStore } from "./store/store.js";
import { workflowAgentKey } from "./store/reduce.js";
import { baseName } from "./lib/path.js";
import { resolveMasterControls } from "./lib/master-controls.js";
import { useShallow } from "zustand/react/shallow";
import { WsClient } from "./ws/client.js";
import type { SocketLike } from "./ws/client.js";
import { Sessions } from "./views/Sessions.js";
import { ConversationPane } from "./components/ConversationPane.js";
import { ResizeHandle } from "./components/ResizeHandle.js";
import { useResizableWidth } from "./lib/useResizableWidth.js";
import { useViewportSize } from "./lib/useViewportSize.js";
import { SIDEBAR_MIN_WIDTH, isCompactSidebar, isShortViewport, sidebarMaxForViewport } from "./lib/layout-budget.js";
import { useMountTransition } from "./lib/useMountTransition.js";
import { useJustEnded } from "./lib/useJustEnded.js";
import { notifyFor } from "./lib/notify.js";
import { latestGate, optimistic, patchSession, patchWorker } from "./lib/optimistic.js";
import { ROW_SELECTED } from "./lib/ui-tokens.js";
import { workerComposerState } from "./lib/worker-composer.js";
import { capabilityCenterRoute, localizeCommandCandidates } from "./lib/command-actions.js";
import type { CapabilityCenterRoute } from "./lib/command-actions.js";
import { useT } from "./i18n/provider.js";
import { RepoTree } from "./views/RepoTree.js";
import { RepoModal } from "./components/RepoModal.js";
import { WorkerSpawnPage } from "./components/WorkerSpawnPage.js";
import { ForkDialog } from "./components/ForkDialog.js";
import { DataConsentModal } from "./components/DataConsentModal.js";
import { OnboardingModal } from "./components/OnboardingModal.js";
import { GettingStartedChecklist } from "./components/GettingStartedChecklist.js";
import { usePrefsStore } from "./store/prefs.js";
import type { Checkpoint } from "./components/CheckpointMenu.js";
import { NewSessionPage, NEW_SESSION_DRAFT_KEY } from "./components/NewSessionPage.js";
import type { SlashCommand } from "./views/Conversation.js";
import { AutomationPage } from "./components/AutomationPage.js";
import { AutomationForm } from "./components/AutomationForm.js";
import { CapabilitiesPage } from "./components/CapabilitiesPage.js";
import { RepositorySettingsPage } from "./components/repository-settings/RepositorySettingsPage.js";
import type { CapabilityCenterApi } from "./components/capabilities/types.js";
import { WorkerHeader, SessionHeader } from "./components/WorkspaceHeaders.js";
import { WindowControls } from "./components/WindowControls.js";
import { DaemonDownBanner } from "./components/DaemonDownBanner.js";
import { RestartDaemonDialog } from "./components/RestartDaemonDialog.js";
import { StatusBar } from "./components/StatusBar.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { SidebarRail } from "./components/SidebarRail.js";
import { ReposHome } from "./components/ReposHome.js";
import { useHistoryShortcuts } from "./lib/useHistoryShortcuts.js";
import { shortBranch } from "./lib/branch.js";
import type { AttentionNav } from "./lib/attention-queue.js";
import { Button } from "./ui/button.js";
import { LoadFailed } from "./ui/load-state.js";
import { Toaster } from "./components/Toaster.js";
import { toast } from "./store/toasts.js";
import { cn } from "./lib/cn.js";
import type { RookeryTerm, RookeryWs, RookeryFs, RookeryResources, RookeryApps, RookeryWin, RookeryUpdate, ResourceSnapshot } from "./types/rookery.js";
import { TerminalPanel } from "./components/TerminalPanel.js";
import { useTermStore, pruneLayout } from "./store/terminals.js";
import { RightSidebar } from "./components/RightSidebar.js";
import { useWsStore, pruneWsPages } from "./store/workspace.js";
import { useLayoutStore } from "./store/layout.js";
import { useDraftStore, pruneDrafts, clearAcceptedDraft } from "./store/drafts.js";
import { switchSpawnRepo, openSpawnedWorker } from "./lib/spawn-navigation.js";
import { readViewState, writeViewState, hasRestorableView } from "./lib/view-state.js";
import { WorkspaceTab } from "./components/WorkspaceTab.js";
import { TabBar } from "./components/TabBar.js";
import { isDockableEnabled } from "./lib/flags.js";
import { WorkspaceDock } from "./workspace/WorkspaceDock.js";
import { WorkspaceRenderProvider, type WorkspaceRender } from "./workspace/WorkspaceRender.js";
import { ActivityPanelBody } from "./workspace/panels.js";
import { FileTree } from "./components/FileTree.js";
import { GitChanges } from "./components/GitChanges.js";
import { SkeletonRows } from "./components/Skeleton.js";
import { useTreeVersion } from "./lib/useTreeVersion.js";
import { useWorkRoot } from "./lib/useWorkRoot.js";

declare global {
  interface Window {
    rookery: { daemon: { ensure(): Promise<string>; status(): Promise<string>; restart(): Promise<string> }; wsUrl(): Promise<string>; pickDirectory(): Promise<string | null>; pickFile(): Promise<string | null>; pickAttachment?(): Promise<SelectedAttachment | null>; openExternal(url: string): Promise<void>; getPathForFile(file: File): string; system: { getLocale(): Promise<string>; setLocale(locale: string): void }; term: RookeryTerm; ws: RookeryWs; fs: RookeryFs; resources: RookeryResources; apps: RookeryApps; notify(p: { title: string; body: string; workerId?: string; sessionId?: string }): Promise<void>; onNotifyClick(cb: (target: { workerId?: string; sessionId?: string }) => void): () => void; platform: string; win: RookeryWin; getVersion(): Promise<string>; update: RookeryUpdate };
  }
}

let client: WsClient | null = null;
// Last-issued-wins gates for the session/fleet list refetches (optimistic Pin/Archive invalidate them).
const sessionListGate = latestGate();
const fleetListGate = latestGate();
let sessionRefreshTimer: ReturnType<typeof setTimeout> | null = null;
let usageTimer: ReturnType<typeof setTimeout> | null = null;
let startTimer: ReturnType<typeof setTimeout> | null = null; // DSK-10: fallback timer to recover from a stuck 'starting' state (refreshed on every connect)

// Poll the usage snapshot. Fast (4s) before data arrives, slow (45s) once it does — lightweight since it only reads the cache.
function pollUsage(c: WsClient): void {
  let failCount = 0; // consecutive usage.get failures — used to gate the "couldn't load" hint below
  let emptyCount = 0; // consecutive successful-but-empty answers
  const schedule = (ms: number) => {
    if (usageTimer) clearTimeout(usageTimer);
    usageTimer = setTimeout(tick, ms);
  };
  const tick = () => {
    void c
      .request({ type: "usage.get" })
      .then((r) => {
        failCount = 0;
        useStore.getState().setUsage(r.usage);
        const ready = !!(r.usage && (r.usage.pct || r.usage.today));
        // A successful answer with no numbers (ccusage missing, not logged in, still aggregating): after a few in a
        // row, say "no usage data" and slow the poll down instead of asking every 4s forever (audit #46).
        emptyCount = ready ? 0 : emptyCount + 1;
        useStore.getState().setUsageEmpty(!ready && emptyCount >= 3);
        schedule(ready ? 45000 : emptyCount >= 3 ? 30000 : 4000);
      })
      .catch(() => {
        failCount++;
        // Only surface the failure hint after a few consecutive misses — a single blip during startup/reconnect
        // shouldn't flash an error (audit #55: sustained failure should say so instead of staying silently blank).
        if (failCount >= 3) useStore.getState().setUsageLoadFailed(true);
        schedule(8000);
      });
  };
  tick();
}

// Auth + integrations status for Settings. A failure is recorded (instead of leaving "checking…" forever) and the
// promise rejects, so Settings' "Check again" can show progress and a second failure (audit #47).
function requestStatusChecks(c: WsClient): Promise<void> {
  const st = useStore.getState;
  return Promise.allSettled([
    c.request({ type: "integrations.status" }).then((r) => st().setIntegrations({ github: r.github, linear: r.linear }), (e: unknown) => { st().setIntegrationsFailed(true); throw e; }),
    c.request({ type: "auth.status" }).then((r) => st().setAuthStatus(r), (e: unknown) => { st().setAuthStatusFailed(true); throw e; }),
  ]).then((results) => {
    const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failed) throw failed.reason;
  });
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
  | "repoSettingsId"
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
  | "sessionsLoadFailed"
  | "fleet"
  | "fleetLoaded"
  | "fleetLoadFailed"
  | "reposLoaded"
  | "reposLoadFailed"
  | "settingsLoadFailed"
  | "integrationsFailed"
  | "authStatusFailed"
  | "usageEmpty"
  | "repos"
  | "overrides"
  | "commands"
  | "running"
  | "attention"
  | "sessionAttention"
  | "usage"
  | "usageLoadFailed"
  | "automations"
  | "automationsLoaded"
  | "automationsLoadFailed"
  | "sessionFilter"
  | "setSessionFilter"
  | "authStatus"
  | "codexModels"
  | "mcpStatus"
  | "capabilityGeneration"
>;

export function App(): JSX.Element {
  const s = useStore(
    useShallow(
      (st): AppSelected => ({
        overlay: st.overlay,
        showRepos: st.showRepos,
        activeSessionId: st.activeSessionId,
        activeWorkerId: st.activeWorkerId,
        repoSettingsId: st.repoSettingsId,
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
        sessionsLoadFailed: st.sessionsLoadFailed,
        fleet: st.fleet,
        fleetLoaded: st.fleetLoaded,
        fleetLoadFailed: st.fleetLoadFailed,
        reposLoaded: st.reposLoaded,
        reposLoadFailed: st.reposLoadFailed,
        settingsLoadFailed: st.settingsLoadFailed,
        integrationsFailed: st.integrationsFailed,
        authStatusFailed: st.authStatusFailed,
        usageEmpty: st.usageEmpty,
        repos: st.repos,
        overrides: st.overrides,
        commands: st.commands,
        running: st.running,
        attention: st.attention,
        sessionAttention: st.sessionAttention,
        usage: st.usage,
        usageLoadFailed: st.usageLoadFailed,
        integrations: st.integrations,
        authStatus: st.authStatus,
        mcpStatus: st.mcpStatus,
        capabilityGeneration: st.capabilityGeneration,
        automations: st.automations,
        automationsLoaded: st.automationsLoaded,
        automationsLoadFailed: st.automationsLoadFailed,
        sessionFilter: st.sessionFilter,
        setSessionFilter: st.setSessionFilter,
        codexModels: st.codexModels,
      }),
    ),
  );
  // Location is a single store model — overlay/showRepos/activeSessionId/activeWorkerId together form one Location.
  // Transitions go through navigate; back/forward through goBack/goForward (browser-style history). A new page = add an Overlay member to the store.
  const { overlay, showRepos, navigate, goBack, goForward } = s;
  // Attention-queue row click → navigate to the target surface (session / worker / automation page).
  const onAttentionNav = useCallback((nav: AttentionNav) => {
    if (nav.overlay === "automation") useStore.getState().navigate({ overlay: "automation" });
    else if (nav.workerId) useStore.getState().navigate({ overlay: null, showRepos: true, subId: nav.workerId });
    else if (nav.sessionId) useStore.getState().navigate({ overlay: null, showRepos: false, sessionId: nav.sessionId });
  }, []);
  const gsDismissed = usePrefsStore((st) => st.gettingStartedDismissed);
  const setGsDismissed = usePrefsStore((st) => st.setGettingStartedDismissed);
  // i18n: closures like connect read the latest locale via tRef (same idiom as notifyRef).
  const t = useT();
  const tRef = useRef(t);
  tRef.current = t;
  const canBack = s.navBack.length > 0;
  const canFwd = s.navFwd.length > 0;
  // Cmd+[ / Cmd+] (Alt+←/→ off macOS) and the mouse back/forward buttons (audit #10).
  useHistoryShortcuts(goBack, goForward);
  // "mission control is online" beat — flash the dot the instant it reaches up (falling edge of "not up"). Keeps led-live.
  const daemonJustUp = useJustEnded(s.daemon !== "up");
  const slackJustUp = useJustEnded(s.slack !== "up");
  // Status-footer suffix words (audit #65) — localized so ko doesn't leak raw English enum values.
  // Daemon: covers every DaemonStatus union member ("up" | "down" | "starting").
  const daemonStatusText = s.daemon === "up" ? t("app.daemonUp") : s.daemon === "starting" ? t("app.daemonStarting") : t("app.daemonDown");
  // Slack: reuses the Settings page's own SlackStatus labels so the two surfaces read identically.
  // Covers every SlackStatus union member ("up" | "connecting" | "error" | "off" | "unconfigured").
  const slackStatusText =
    s.slack === "up" ? t("settings.slackUp")
    : s.slack === "connecting" ? t("settings.slackConnecting")
    : s.slack === "error" ? t("settings.slackError")
    : s.slack === "off" ? t("settings.slackOff")
    : t("settings.slackNoToken");
  const closeOverlay = () => navigate({ overlay: null });
  const [capabilityRoute, setCapabilityRoute] = useState<CapabilityCenterRoute>({ tab: "effective" });
  const [capabilityPreviewTarget, setCapabilityPreviewTarget] = useState<CapabilityPreviewTarget | null>(null);
  const [capabilityOpenEpoch, setCapabilityOpenEpoch] = useState(0);
  const displayCommands = useMemo(() => localizeCommandCandidates(s.commands, t), [s.commands, t]);
  const handleCommandAction = useCallback((action: CommandAction) => {
    const route = capabilityCenterRoute(action);
    if (!route) return;
    setCapabilityPreviewTarget(null);
    setCapabilityOpenEpoch((value) => value + 1);
    setCapabilityRoute(route);
    navigate({ overlay: "capabilities" });
  }, [navigate]);
  const toggleCapabilityCenter = useCallback(() => {
    if (overlay === "capabilities") {
      navigate({ overlay: null });
      return;
    }
    setCapabilityPreviewTarget(null);
    setCapabilityOpenEpoch((value) => value + 1);
    setCapabilityRoute({ tab: "effective" });
    navigate({ overlay: "capabilities" });
  }, [navigate, overlay]);
  const openCapabilityCatalog = useCallback(() => {
    setCapabilityPreviewTarget(null);
    setCapabilityOpenEpoch((value) => value + 1);
    setCapabilityRoute({ tab: "library" });
    navigate({ overlay: "capabilities" });
  }, [navigate]);
  const openAdvancedCapabilityAssignments = useCallback(() => {
    setCapabilityPreviewTarget(null);
    setCapabilityOpenEpoch((value) => value + 1);
    setCapabilityRoute({ tab: "assignments" });
    navigate({ overlay: "capabilities" });
  }, [navigate]);
  const openRookeryCapabilityPreview = useCallback(() => {
    setCapabilityPreviewTarget({ kind: "rookery", provider: "claude", agent: "master" });
    setCapabilityOpenEpoch((value) => value + 1);
    setCapabilityRoute({ tab: "effective" });
    navigate({ overlay: "capabilities" });
  }, [navigate]);
  const openRepoCapabilityPreview = useCallback((repoId: string) => {
    setCapabilityPreviewTarget({ kind: "repo", id: repoId, provider: "claude", agent: "master" });
    setCapabilityOpenEpoch((value) => value + 1);
    setCapabilityRoute({ tab: "effective" });
    navigate({ overlay: "capabilities" });
  }, [navigate]);
  const [repoModal, setRepoModal] = useState(false);
  // The spawn page's target repo lives in the navigation Location (overlay "spawnWorker" + repoId), so back/forward
  // and sidebar navigation treat it like every other full page.
  const spawnRepoRow = s.overlay === "spawnWorker" ? s.repos.find((repo) => repo.id === s.repoSettingsId) ?? null : null;
  const spawnRepo = spawnRepoRow?.name ?? null;
  const [spawnBranches, setSpawnBranches] = useState<string[]>([]);
  const [spawnBranchesState, setSpawnBranchesState] = useState<"loading" | "ready" | "failed">("loading");
  // Cross-provider fork dialog target (master session or worker) — the right-click "Fork" opens this instead of an instant fork.
  const [forkTarget, setForkTarget] = useState<{ kind: "master" | "worker"; id: string; sourceProvider: string } | null>(null);
  // Bump to remount the master ConversationPane — the composer reads its draft only on mount, so a
  // programmatically-seeded draft (Getting Started "first worker" example) needs this when already viewing the session.
  const [composerEpoch, setComposerEpoch] = useState(0);
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
  // Notification click → jump to the target: worker (Repos view) or session (Sessions view — attention-queue tier-0 notify).
  useEffect(() => window.rookery.onNotifyClick((target) => {
    if (target.sessionId) useStore.getState().navigate({ overlay: null, showRepos: false, sessionId: target.sessionId });
    else if (target.workerId) useStore.getState().navigate({ overlay: null, showRepos: true, subId: target.workerId });
  }), []);
  // Reset edit state when leaving the automation overlay — so re-entering shows the list instead of a stale form.
  useEffect(() => { if (overlay !== "automation") setEditJob(null); }, [overlay]);
  // When the spawn modal opens, load the base-branch candidates for that repo.
  useEffect(() => {
    setSpawnBranches([]); // never offer the previous repo's branches while the new repo's list loads
    setSpawnBranchesState("loading"); // the picker holds its place (disabled) instead of popping in later (audit #36)
    if (!spawnRepo || !client) return;
    let live = true; // prevent a late response from the previous repo from overwriting when spawnRepo changes
    void client.request({ type: "repo.branches", repo: spawnRepo })
      .then((r) => { if (live) { setSpawnBranches(r.branches ?? []); setSpawnBranchesState("ready"); } })
      .catch(() => { if (live) { setSpawnBranches([]); setSpawnBranchesState("failed"); } });
    return () => { live = false; };
  }, [spawnRepo]);
  // Failures propagate: the spawn page shows "search failed" instead of an empty "no results" (audit #36).
  const searchSource = (provider: "github" | "linear", query: string): Promise<SourceItem[]> =>
    client ? client.request({ type: "source.search", provider, query, repo: spawnRepo ?? undefined }).then((r) => r.items ?? []) : Promise.reject(new Error("not connected"));
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
  // cwd must be in deps so that even when session.list arrives late (initially undefined→home), the root is re-resolved once cwd is filled in.
  const wsSessionCwd = s.sessions.find((x) => x.id === s.activeSessionId)?.cwd;
  // Worker's fleet status feeds useWorkRoot so a terminal status (worktree gone/orphaned) short-circuits the retry
  // loop instead of waiting it out (audit #2). Only meaningful when viewing a worker (showRepos + a real subId).
  const activeWorkerStatus = showRepos && s.activeWorkerId ? s.fleet[s.activeWorkerId]?.status : undefined;
  const { root: wsRootRaw, state: wsRootState } = useWorkRoot({
    enabled: !!termPageKey,
    subId: showRepos ? s.activeWorkerId ?? undefined : undefined,
    cwd: showRepos ? undefined : wsSessionCwd,
    status: activeWorkerStatus,
  });
  const wsRoot = wsRootRaw ?? "";
  const treeVersion = useTreeVersion(wsRootRaw); // fs-watch bump for the dockable files/git panels (parity with RightSidebar)
  const viewport = useViewportSize();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("rookery.sidebar") === "1");
  const leftPanel = useResizableWidth("rookery.leftWidth", 252, {
    min: SIDEBAR_MIN_WIDTH,
    max: sidebarMaxForViewport(viewport.width),
    side: "left",
  });
  const compactSidebar = isCompactSidebar(leftPanel.width);
  const shortViewport = isShortViewport(viewport.height);
  const toggleSidebar = () =>
    setCollapsed((v) => {
      localStorage.setItem("rookery.sidebar", v ? "0" : "1");
      return !v;
    });
  // Resource monitor: polls via IPC (resources:get). Faster when the popover is open, paused when the window is hidden.
  const [resources, setResources] = useState<ResourceSnapshot | null>(null);
  const [resOpen, setResOpen] = useState(false);
  // Consecutive resources.get failures: after a few, the popover shows a failure + refresh instead of a skeleton
  // that never resolves (audit #137). Any success clears it.
  const [resourcesFailed, setResourcesFailed] = useState(false);
  const resourceFails = useRef(0);
  const pollResourcesOnce = useCallback(() => {
    void window.rookery.resources.get().then(
      (r) => { resourceFails.current = 0; setResourcesFailed(false); setResources(r); },
      () => { resourceFails.current += 1; if (resourceFails.current >= 3) setResourcesFailed(true); },
    );
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
  const mounted = useRef(true);
  const restoredView = useRef(false);
  // A saved location may still be restored once both lists arrive: until then the empty main area shows a
  // conversation skeleton rather than flashing (and focusing) the New Session page (audit #43).
  const [restorePending, setRestorePending] = useState(() => hasRestorableView(readViewState()));
  const restoredTermPages = useRef<Set<string>>(new Set());
  const loadWorkerHistory = useCallback((workerId: string, connection: WsClient | null = client): void => {
    if (!connection) return;
    void connection.request({ type: "worker.history", id: workerId })
      .then((result) => useStore.getState().seedWorkerHistory(workerId, result.events ?? []))
      .catch(() => useStore.getState().setHistoryLoadFailed(workerId, true));
    void connection.request({ type: "workflow.list", workerId })
      .then((result) => useStore.getState().seedWorkflowRuns(workerId, result.runs))
      .catch(() => {}); // reconnect hydration only; live events continue even if this snapshot misses
  }, []);
  const loadWorkflowAgentHistory = useCallback((workerId: string, taskId: string, agentId: string): void => {
    const key = workflowAgentKey(workerId, taskId, agentId);
    const store = useStore.getState();
    if (Object.prototype.hasOwnProperty.call(store.workflowAgentLogs, key) || store.workflowAgentHistoryLoading[key]) return;
    store.beginWorkflowAgentHistory(key);
    if (!client) {
      store.failWorkflowAgentHistory(key);
      return;
    }
    void client.request({ type: "workflow.agent.history", workerId, taskId, agentId })
      .then((result) => useStore.getState().seedWorkflowAgentHistory(key, result.events))
      .catch(() => useStore.getState().failWorkflowAgentHistory(key));
  }, []);
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

  // Entering Settings re-asks auth/integrations once, so a status that failed (or went stale) at connect time
  // gets another chance without a reconnect (audit #47).
  useEffect(() => {
    if (overlay === "settings" && client && s.daemon === "up") void requestStatusChecks(client).catch(() => {});
  }, [overlay, s.daemon]);

  // Restore the viewing location + prune dead workspace tabs: apply once after **both** the session and fleet lists arrive.
  // (Acting on just one means that when fleet arrives late, known lacks the worker keys and the whole worker page gets pruned.)
  useEffect(() => {
    if (restoredView.current) return;
    if (s.daemon !== "up") return;
    if (!s.sessionsLoaded || !s.fleetLoaded) return; // wait until both lists have arrived
    restoredView.current = true;
    setRestorePending(false); // batched with restoreLocation below, so the skeleton swaps straight to the restored page
    // NEW_SESSION_DRAFT_KEY is a fixed page key (not a session/worker id) — include it so pruneDrafts doesn't
    // treat it as a dead page and wipe the New Session draft on every boot (audit #5 review).
    const known = new Set<string>([...s.sessions.map((x) => x.id), ...Object.keys(s.fleet), NEW_SESSION_DRAFT_KEY]);
    // Prune dead pages; draft pruning also retains Side drafts whose stable source target still exists.
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
      useStore.getState().restoreLocation({ overlay: null, showRepos: true, sessionId: null, subId, repoId: null });
      loadWorkerHistory(subId);
    } else if (v.sessionId && s.sessions.some((x) => x.id === v.sessionId)) {
      const sessionId = v.sessionId;
      useStore.getState().restoreLocation({ overlay: null, showRepos: v.showRepos, sessionId, subId: null, repoId: null });
      void client?.request({ type: "session.history", sessionId }).then((r) => useStore.getState().seedHistory(sessionId, r.events ?? [])).catch(() => useStore.getState().setHistoryLoadFailed(sessionId, true));
    }
  }, [s.daemon, s.sessionsLoaded, s.fleetLoaded, loadWorkerHistory]);

  // When the active conversation pane changes, prefetch and cache that context's slash command/skill candidates (for / autocomplete).
  const commandsTarget = useRef<string | null>(null);
  useEffect(() => {
    const c = client;
    if (s.daemon !== "up" || !c) return;
    let msg: { type: "commands.list"; sessionId?: string; workerId?: string } | null = null;
    if (s.activeWorkerId) {
      msg = { type: "commands.list", workerId: s.activeWorkerId };
    } else if (s.activeSessionId) {
      msg = { type: "commands.list", sessionId: s.activeSessionId };
    }
    if (!msg) { useStore.getState().setCommands([]); return; }
    let live = true; // prevent a late commands response from the previous context from overwriting when switching conversation panes
    // Clear on a target switch and on failure: the previous target's commands (another provider's /name vs $name) must
    // never linger (audit #35). A refetch for the same target (capability change) keeps the list until the reply lands.
    const target = s.activeWorkerId ?? s.activeSessionId;
    if (commandsTarget.current !== target) { commandsTarget.current = target; useStore.getState().setCommands([]); }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    void c.request(msg).then((r) => { if (live) useStore.getState().setCommands(r.commands ?? []); }).catch(() => { if (live) useStore.getState().setCommands([]); });
    return () => { live = false; };
  }, [s.activeSessionId, s.activeWorkerId, s.capabilityGeneration, s.daemon]);

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
        if (e.type === "worker.status" && notifyRef.current && !useStore.getState().deletingWorkers[e.workerId]) {
          const row = useStore.getState().fleet[e.workerId];
          const n = notifyFor(row?.status, e.status, row?.label ?? e.workerId, tRef.current);
          if (n) void window.rookery.notify({ ...n, workerId: e.workerId });
        }
        // Attention-queue tier 0: a master turn is BLOCKED on a human answer — the one transition worth an OS
        // notification even more than worker settles (main suppresses it while the window is focused).
        if (e.type === "interaction.request" && notifyRef.current) {
          const sess = useStore.getState().sessions.find((x) => x.id === e.sessionId);
          void window.rookery.notify({
            title: tRef.current("attentionBell.notifyTitle"),
            body: tRef.current("attentionBell.notifyBody", { label: sess?.label ?? e.sessionId.slice(0, 8) }),
            sessionId: e.sessionId,
          });
        }
        useStore.getState().applyEvent(e);
        if (e.type === "commands.changed") {
          const state = useStore.getState();
          const request = e.scopeId === state.activeWorkerId
            ? { type: "commands.list" as const, workerId: e.scopeId }
            : e.scopeId === state.activeSessionId
              ? { type: "commands.list" as const, sessionId: e.scopeId }
              : null;
          if (request) void c.request(request).then((response) => {
            const current = useStore.getState();
            if (e.scopeId === current.activeWorkerId || e.scopeId === current.activeSessionId) current.setCommands(response.commands ?? []);
          }).catch(() => {});
        }
        if (e.type === "automation.changed") { void c.request({ type: "automation.list" }).then((r) => useStore.getState().setAutomations(r.automations ?? [])).catch(() => {}); }
        if (e.type === "worker.deletion" && e.phase === "failed") {
          void c.request({ type: "fleet.list" }).then((r) => useStore.getState().setFleet(r.fleet ?? [])).catch(() => {});
        }
        // Session activity/appearance → refresh the list. (For agent.* events that are results or for a session we don't know yet.)
        if (e.type.startsWith("master.")) {
          const sid = (e as { sessionId?: string }).sessionId;
          if (e.type === "master.result" || (sid && !useStore.getState().sessions.some((x) => x.id === sid))) {
            scheduleSessionRefresh(c);
          }
        }
        if (
          e.type === "worker.status" &&
          ["failed", "stopped", "error"].includes(e.status) &&
          !useStore.getState().deletingWorkers[e.workerId]
        ) {
          void c.request({ type: "fleet.list" }).then((r) => useStore.getState().setFleet(r.fleet ?? [])).catch(() => {});
        }
      },
    );
    client = c;
    setImageClient(c);
    c.onOpen(() => {
      if (startTimer) { clearTimeout(startTimer); startTimer = null; } // connection succeeded → release the fallback timer (DSK-10)
      useStore.getState().resetLiveInteractions(); // must precede events.subscribe: the replay repopulates the set
      useStore.getState().bumpConnectionEpoch(); // pending bubbles from before this reconnect become prunable at seed time
      useStore.getState().resetWorkerDeletions(); // daemon restart recovery: an uncommitted deletion may legitimately return
      useStore.getState().setDaemon("up");
      // A rejection here (vs. the swallowed .catch(()=>{}) elsewhere) sets the loadFailed flag so Sessions/RepoTree can
      // show an error+retry row instead of staying blank forever when the initial fetch never arrives (audit #14).
      void c.request({ type: "session.list" }).then((r) => { useStore.getState().setSessions(r.sessions ?? []); useStore.getState().seedRunningFromSessions(r.sessions ?? []); }).catch(() => useStore.getState().setSessionsLoadFailed(true));
      void c.request({ type: "fleet.list" }).then((r) => useStore.getState().setFleet(r.fleet ?? [])).catch(() => useStore.getState().setFleetLoadFailed(true));
      void c.request({ type: "repos.list" }).then((r) => useStore.getState().setRepos(r.repos ?? [])).catch(() => useStore.getState().setReposLoadFailed(true));
      c.send({ type: "events.subscribe" }); // global channel: receive all session/fleet events
      pollUsage(c);
      void c.request({ type: "settings.get" }).then((r) => useStore.getState().setSettings(r.settings)).catch(() => useStore.getState().setSettingsLoadFailed(true));
      void c.request({ type: "models.list" }).then((r) => useStore.getState().setModels((r.models ?? []).map((m) => ({ id: m.id, label: m.displayName })))).catch(() => {});
      void c.request({ type: "codex.models.list" }).then((r) => useStore.getState().setCodexModels(r.models ?? null)).catch(() => {});
      void c.request({ type: "codex.authStatus" }).then((r) => useStore.getState().setCodexAuthStatus(r.status ?? "unavailable")).catch(() => useStore.getState().setCodexAuthStatus("unavailable"));
      void c.request({ type: "mcp.status" }).then((r) => useStore.getState().setMcpStatus({ scope: r.scope, url: r.url })).catch(() => {});
      void requestStatusChecks(c).catch(() => {});
      void c.request({ type: "automation.list" }).then((r) => useStore.getState().setAutomations(r.automations ?? [])).catch(() => useStore.getState().setAutomationsLoadFailed(true));
      // On reconnect, re-seed the open conversation — to prevent cards from being stuck in_progress forever due to a
      // tool-end/result lost while disconnected (the DB is the source of truth, so we re-fetch the full transcript and overwrite).
      const { activeSessionId, activeWorkerId } = useStore.getState();
      if (activeSessionId) void c.request({ type: "session.history", sessionId: activeSessionId }).then((r) => useStore.getState().seedHistory(activeSessionId, r.events ?? [])).catch(() => useStore.getState().setHistoryLoadFailed(activeSessionId, true));
      if (activeWorkerId) loadWorkerHistory(activeWorkerId, c);
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
  }, [loadWorkerHistory]);

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
      setImageClient(null);
    };
  }, [connect]);

  const select = useCallback((id: string) => {
    useStore.getState().navigate({ overlay: null, showRepos: false, sessionId: id }); // select session → sessions view / close full page
    // Live events arrive via the @all global subscription, so no separate attach is needed. Seed only the past conversation.
    void client?.request({ type: "session.history", sessionId: id }).then((r) => useStore.getState().seedHistory(id, r.events ?? [])).catch(() => useStore.getState().setHistoryLoadFailed(id, true));
  }, []);
  // Retry hook for MessageList's load-failed row (audit #43) — re-fires the same history fetch that failed, for either kind.
  const retryHistory = useCallback((k: "master" | "worker", id: string) => {
    if (k === "worker") loadWorkerHistory(id);
    else void client?.request({ type: "session.history", sessionId: id }).then((r) => useStore.getState().seedHistory(id, r.events ?? [])).catch(() => useStore.getState().setHistoryLoadFailed(id, true));
  }, [loadWorkerHistory]);
  const create = () => navigate({ overlay: "newSession" }); // open the new-session full page (mutually exclusive with settings/automation)
  // Getting Started "first worker": land the user in a composer pre-filled with an example natural-language ask
  // (register the repo → spawn a worker → report back). With no usable session yet, seed the New Session page's
  // draft instead. Existing drafts are never clobbered; the epoch bump makes an already-mounted pane pick the seed up.
  const suggestFirstWorker = () => {
    const drafts = useDraftStore.getState();
    const latest = useStore.getState().sessions
      .filter((x) => !x.archived && x.origin !== "slack") // slack sessions are read-only in the UI
      .sort((a, b) => (a.lastActivity < b.lastActivity ? 1 : a.lastActivity > b.lastActivity ? -1 : 0))[0];
    if (!latest) {
      if (!drafts.byPage[NEW_SESSION_DRAFT_KEY]) drafts.setDraft_(NEW_SESSION_DRAFT_KEY, t("gettingStarted.workerPrompt"));
      create();
      return;
    }
    if (!drafts.byPage[latest.id]) drafts.setDraft_(latest.id, t("gettingStarted.workerPrompt"));
    setComposerEpoch((e) => e + 1);
    useStore.getState().navigate({ overlay: null, showRepos: false, sessionId: latest.id });
  };
  // List loaders return their promise (rejecting on failure) so a sidebar Retry can show progress and a second
  // failure (audit #44); the fire-and-forget refetch* wrappers keep the old swallow-on-error behaviour.
  const loadSessions = useCallback((): Promise<void> => {
    const c = client;
    if (!c) return Promise.reject(new Error("not connected"));
    const n = sessionListGate.next();
    return c.request({ type: "session.list" }).then(
      (r) => { if (sessionListGate.isCurrent(n)) useStore.getState().setSessions(r.sessions ?? []); },
      (e: unknown) => { if (!useStore.getState().sessionsLoaded) useStore.getState().setSessionsLoadFailed(true); throw e; },
    );
  }, []);
  const refetchSessions = useCallback(() => { void loadSessions().catch(() => {}); }, [loadSessions]);
  // Rename session — refetch not needed since it updates live via the session.label event.
  // Inject reqId via request() (schema requires reqId) — the daemon replies with fleet.ack (the label reflects live via session.label; the ack is ignored).
  const renameSession = useCallback((id: string, label: string) => { void client?.request({ type: "session.rename", sessionId: id, label }).catch((e) => toast.error(tRef.current("toast.saveFailed"), String(e))); }, []);
  // Pin/Archive move the row at once and roll back (with a toast) if the daemon rejects it (audit #56).
  // A list fetched before the click is dropped (invalidate) so it can't flip the row back; both outcomes refetch.
  const archiveSession = useCallback((id: string, archived: boolean) => {
    const c = client;
    if (!c) return;
    sessionListGate.invalidate();
    void optimistic(() => patchSession(id, { archived }), () => c.request({ type: "session.archive", sessionId: id, archived }), { onError: (e) => toast.error(tRef.current("toast.actionFailed"), String(e)), onSettled: refetchSessions });
  }, [refetchSessions]);
  const pinSession = useCallback((id: string, pinned: boolean) => {
    const c = client;
    if (!c) return;
    sessionListGate.invalidate();
    void optimistic(() => patchSession(id, { pinned }), () => c.request({ type: "session.pin", sessionId: id, pinned }), { onError: (e) => toast.error(tRef.current("toast.actionFailed"), String(e)), onSettled: refetchSessions });
  }, [refetchSessions]);
  // Right-click "Fork" → open the Fork dialog (target provider/model/effort pick + codex-auth gate), not an instant fork.
  const forkSession = useCallback((id: string) => {
    const provider = useStore.getState().sessions.find((x) => x.id === id)?.provider ?? "claude";
    setForkTarget({ kind: "master", id, sourceProvider: provider });
  }, []);
  // Perform the master fork with the dialog's chosen target. session.fork carries ONLY provider (there is no
  // session model column); the chosen model/effort are applied as the new session's per-session override after
  // the fork. Then reuse the existing post-fork navigate + seedHistory path.
  const runForkSession = useCallback((id: string, target: { provider: string; model?: string; effort?: string }) => {
    void client?.request({ type: "session.fork", sessionId: id, provider: target.provider as "claude" | "codex" }).then((r) => {
      refetchSessions();
      if (target.model || target.effort) useStore.getState().setOverride(r.sessionId, { model: target.model, effort: target.effort });
      useStore.getState().navigate({ overlay: null, showRepos: false, sessionId: r.sessionId });
      void client?.request({ type: "session.history", sessionId: r.sessionId }).then((h) => useStore.getState().seedHistory(r.sessionId, h.events ?? [])).catch(() => useStore.getState().setHistoryLoadFailed(r.sessionId, true));
    }).catch((e) => toast.error(tRef.current("toast.forkFailed"), String(e)));
  }, [refetchSessions]);
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
  const loadFleet = useCallback((): Promise<void> => {
    const c = client;
    if (!c) return Promise.reject(new Error("not connected"));
    const n = fleetListGate.next();
    return c.request({ type: "fleet.list" }).then(
      (r) => { if (fleetListGate.isCurrent(n)) useStore.getState().setFleet(r.fleet ?? []); },
      (e: unknown) => { if (!useStore.getState().fleetLoaded) useStore.getState().setFleetLoadFailed(true); throw e; },
    );
  }, []);
  const refetchFleet = useCallback(() => { void loadFleet().catch(() => {}); }, [loadFleet]);
  const loadRepos = useCallback((): Promise<void> => {
    const c = client;
    if (!c) return Promise.reject(new Error("not connected"));
    return c.request({ type: "repos.list" }).then(
      (r) => useStore.getState().setRepos(r.repos ?? []),
      (e: unknown) => { if (!useStore.getState().reposLoaded) useStore.getState().setReposLoadFailed(true); throw e; },
    );
  }, []);
  // The repo tree needs both lists; its Retry re-fires whichever has not arrived yet.
  const retryRepoTree = useCallback((): Promise<void> => {
    const st = useStore.getState();
    return Promise.all([st.fleetLoaded ? null : loadFleet(), st.reposLoaded ? null : loadRepos()]).then(() => {});
  }, [loadFleet, loadRepos]);
  const loadSettings = useCallback((): Promise<void> => {
    const c = client;
    if (!c) return Promise.reject(new Error("not connected"));
    return c.request({ type: "settings.get" }).then(
      (r) => useStore.getState().setSettings(r.settings),
      (e: unknown) => { useStore.getState().setSettingsLoadFailed(true); throw e; },
    );
  }, []);
  // Retry hook for AutomationPage's load-failed row (audit #14) — no other refetch path existed for automation.list.
  const refetchAutomations = useCallback((): Promise<void> => {
    const c = client;
    if (!c) return Promise.reject(new Error("not connected"));
    return c.request({ type: "automation.list" }).then(
      (r) => useStore.getState().setAutomations(r.automations ?? []),
      (e: unknown) => { useStore.getState().setAutomationsLoadFailed(true); throw e; },
    );
  }, []);
  // Rename worker — updates live via the worker.label event. Archive/delete refetch fleet.list.
  const renameSub = useCallback((id: string, label: string) => { void client?.request({ type: "worker.rename", id, label }).catch((e) => toast.error(tRef.current("toast.saveFailed"), String(e))); }, []);
  const archiveSub = useCallback((id: string, archived: boolean) => {
    const c = client;
    if (!c) return;
    fleetListGate.invalidate();
    void optimistic(() => patchWorker(id, { archived }), () => c.request({ type: "worker.archive", id, archived }), { onError: (e) => toast.error(tRef.current("toast.actionFailed"), String(e)), onSettled: refetchFleet });
  }, [refetchFleet]);
  const deleteSub = useCallback((id: string) => {
    const store = useStore.getState();
    if (store.activeWorkerId === id) store.navigate({ subId: null });
    store.beginWorkerDeletion(id);
    void client?.request({ type: "worker.delete", id }).then(() => {
      useLayoutStore.getState().clear_(id); // only after the daemon confirms (audit #34) — a failed delete restores the row AND keeps its layout
      useStore.getState().completeWorkerDeletion(id); // idempotent fallback if the lifecycle event was missed
    }).catch((e) => {
      useStore.getState().failWorkerDeletion(id);
      toast.error(tRef.current("toast.deleteFailed"), String(e));
      refetchFleet();
    });
  }, [refetchFleet]);
  // Start a new session: create a session at cwd → (save model/effort overrides) → select → send the first turn if there's a prompt.
  const startSession = async (opts: { cwd?: string; prompt?: string; images?: ImageRef[]; model?: string; effort: string; provider?: string; speed?: SpeedPreference | null }): Promise<void> => {
    const c = client;
    if (!c) throw new Error("not connected");
    const acceptedDraft = useDraftStore.getState().byPage[NEW_SESSION_DRAFT_KEY];
    // A failure is thrown to the composer, which reports it inline next to the kept draft (one surface, audit #32).
    const result = await c.request({type:"session.create",speed: opts.speed,...(opts.cwd ? {cwd:opts.cwd}:{}),...(opts.provider ? {provider:opts.provider as "claude"|"codex"}:{})});
    const list = await c.request({type:"session.list"});
    useStore.getState().setSessions(list.sessions ?? []);
    const sid = result.sessionId;
    useStore.getState().setOverride(sid,{model:opts.model,effort:opts.effort});
    useStore.getState().setHistoryLoaded(sid,true);
    const prompt=opts.prompt?.trim() ?? "";
    if(prompt || opts.images?.length) {
      const clientMsgId=crypto.randomUUID();
      useStore.getState().pushPending(sid,{clientMsgId,text:prompt,...(opts.images?.length ? {images:opts.images}:{})});
      try { await c.request({type:"session.send",sessionId:sid,text:prompt,images:opts.images,model:opts.model,effort:opts.effort,speed: opts.speed,clientMsgId}); }
      catch(error) { useStore.getState().dropPending(sid,clientMsgId); throw error; }
    }
    clearAcceptedDraft(NEW_SESSION_DRAFT_KEY,prompt,opts.images,acceptedDraft);
    navigate({overlay:null}); select(sid);
  };
  const send = useCallback(async (text: string, images?: ImageRef[]) => {
    const st = useStore.getState();
    const sid = st.activeSessionId;
    if (!sid) return;
    if (st.sessions.find((x) => x.id === sid)?.origin === "slack") return; // Slack sessions are read-only in the UI
    const acceptedDraft = useDraftStore.getState().byPage[sid];
    const clientMsgId = crypto.randomUUID();
    st.pushPending(sid, { clientMsgId, text, ...(images?.length ? {images} : {}) }); // pending bubble: immediately "in progress" (stop button) → switches to committed when the daemon's user echo arrives
    const ov = st.overrides[sid] ?? {}; // per-session override (backend uses defaults if absent)
    // Send the SAME effort the composer displays, re-derived fresh from the current settings + catalog so a
    // codex session never sends a level its model lacks. The daemon's per-model catalog guard only works once its
    // model/list cache is warm, so raw ov.effort=undefined could still run the masterEffort default at a level the
    // model may not support (e.g. gpt-5.4 has no xhigh) — diverging from the shown effort.
    // Re-resolving here (not pinning) keeps live settings changes reflected. Claude passes its choice through.
    const provider = st.sessions.find((x) => x.id === sid)?.provider;
    const sendEffort = st.settings
      ? resolveMasterControls({ provider, override: ov, masterModel: st.settings.masterModel, codexMasterModel: st.settings.codexMasterModel, masterEffort: st.settings.masterEffort, codexModels: st.codexModels }).effort
      : ov.effort;
    // request(): a rejected send (unknown session, runTurn throw, disconnected) rolls the pending bubble back and surfaces a toast —
    // fire-and-forget used to drop the daemon's error frame (no reqId) and the message silently vanished while the composer stayed stuck busy.
    if (!client) { st.dropPending(sid,clientMsgId); throw new Error("not connected"); }
    // The rejection reaches the composer (or the failed bubble's Retry), which reports it inline — no toast too (audit #32).
    await client.request({ type: "session.send", sessionId: sid, text, images, speed: st.sessions.find((x) => x.id === sid)?.speed, model: ov.model, effort: sendEffort, permissionMode: ov.permissionMode as "default" | "acceptEdits" | "bypassPermissions" | "plan" | undefined, clientMsgId }).catch((e) => {
      useStore.getState().dropPending(sid, clientMsgId);
      throw e;
    });
    clearAcceptedDraft(sid,text,images,acceptedDraft);
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
    loadWorkerHistory(id);
  }, [loadWorkerHistory]);
  // Right-click "Fork" → open the Fork dialog. Workers persist model/effort as columns, so those ride along in worker.fork.
  const forkSub = useCallback((id: string) => {
    const provider = useStore.getState().fleet[id]?.provider ?? "claude";
    setForkTarget({ kind: "worker", id, sourceProvider: provider });
  }, []);
  const runForkSub = useCallback((id: string, target: { provider: string; model?: string; effort?: string }) => {
    void client?.request({ type: "worker.fork", id, provider: target.provider as "claude" | "codex", model: target.model, effort: target.effort }).then((r) => { refetchFleet(); selectSub(r.id); }).catch((e) => toast.error(tRef.current("toast.forkFailed"), String(e)));
  }, [refetchFleet, selectSub]);
  const subSend = useCallback(async (id: string, text: string, images?: ImageRef[]) => {
    const acceptedDraft = useDraftStore.getState().byPage[id];
    const clientMsgId = crypto.randomUUID();
    // Show a queued bubble immediately → after the worker finishes its current turn (boundary echo) it switches to committed and settles into place.
    useStore.getState().pushWorkerPending(id, { clientMsgId, text, ...(images?.length ? {images} : {}) });
    // request(): a rejected send (mid-restore, terminated worker, disconnected) rolls the bubble back and surfaces a toast —
    // fire-and-forget used to drop the daemon's error frame (no reqId) and the message silently vanished.
    if (!client) { useStore.getState().dropWorkerPending(id,clientMsgId); throw new Error("not connected"); }
    await client.request({ type: "worker.send", id, text, images, speed: useStore.getState().fleet[id]?.speed, clientMsgId }).catch((e) => {
      useStore.getState().dropWorkerPending(id, clientMsgId);
      throw e; // reported inline by the composer / failed bubble (audit #32)
    });
    clearAcceptedDraft(id,text,images,acceptedDraft);
  }, []);
  const subSetModel = useCallback((id: string, model: string) => {
    const prev = useStore.getState().fleet[id]?.model;
    // Optimistic: update the fleet row model immediately (reflects the dropdown value).
    useStore.setState((st) => (st.fleet[id] ? { fleet: { ...st.fleet, [id]: { ...st.fleet[id], model } } } : {}));
    // request(): a rejected change (terminated worker, disconnected) rolls the dropdown back so it doesn't lie about the applied value.
    useStore.getState().invalidateSpeed("worker", id);
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
  // Stop one listed background task of a worker (header task menu) — the worker and its turn keep running.
  const subStopTask = useCallback((id: string, taskId: string) => { void client?.request({ type: "worker.task.stop", id, taskId }).catch((e) => toast.error(tRef.current("toast.actionFailed"), String(e))); }, []);
  // Recover a wedged worker whose soft interrupt won't land (stuck in a long tool call / Dynamic Workflow): hard-kill
  // and resume the session in place → idle, still usable. Surfaced by the composer's Stop escalation (onRecover).
  // Returns the request so the composer can show Recover in flight (audit #34); success is confirmed with an info toast.
  const subRecover = useCallback(async (id: string): Promise<void> => {
    if (!client) return;
    await client.request({ type: "worker.recover", id })
      .then(() => { toast.info(tRef.current("composer.recovered")); })
      .catch((e) => { toast.error(tRef.current("toast.actionFailed"), String(e)); });
  }, []);
  const startSide = useCallback(async (sourceKind: "master" | "worker", sourceId: string, text: string, model?: string, effort?: string, images?: ImageRef[]): Promise<string> => {
    const c = client;
    if (!c) throw new Error("not connected");
    // Failures surface where the question was asked: inline in the composer, or a toast for a /side command.
    const result = await c.request({ type: "side.start", sourceKind, sourceId, text, images, model, effort });
    return result.sideId;
  }, []);
  const sendSide = useCallback(async (sideId: string, text: string, images?: ImageRef[]) => {
    if (!client) throw new Error("not connected");
    await client.request({ type: "side.send", sideId, text, images }); // a failure is reported inline by the drawer's composer
  }, []);
  const stopSide = useCallback((sideId: string) => {
    void client?.request({ type: "side.stop", sideId }).catch((error) => toast.error(tRef.current("toast.actionFailed"), String(error)));
  }, []);
  const closeSide = useCallback((sideId: string) => {
    void client?.request({ type: "side.close", sideId }).catch((error) => toast.error(tRef.current("toast.actionFailed"), String(error)));
  }, []);
  const spawnSub = async (task: string, label: string, model?: string, effort?: string, base?: string, ticket?: { key: string; url: string }, permissionMode?: string, provider?: string, costBudgetUsd?: number, speed?: SpeedPreference | null): Promise<void> => {
    const c = client;
    const repo = spawnRepo;
    const repoId = spawnRepoRow?.id ?? null; // the spawn page this request came from (see openSpawnedWorker)
    if (!c || !repo) {
      const error = new Error("not connected");
      toast.error(tRef.current("toast.spawnFailed"), String(error));
      throw error;
    }
    const result = await c.request({ type: "fleet.spawn", repo, task, label: label || repo, model, effort, base, ticketKey: ticket?.key, ticketUrl: ticket?.url, permissionMode: permissionMode as "bypassPermissions" | "plan" | undefined, provider: provider as "claude" | "codex" | undefined, costBudgetUsd, speed }).catch((error) => {
      toast.error(tRef.current("toast.spawnFailed"), String(error));
      throw error;
    });
    // Spawn has already succeeded at this point. Refresh in the background so a secondary list failure
    // cannot keep the form open and tempt the user into creating a duplicate worker.
    void c.request({ type: "fleet.list" })
      .then((response) => useStore.getState().setFleet(response.fleet ?? []))
      .catch((error) => toast.error(tRef.current("toast.actionFailed"), String(error)));
    if (result.id) {
      // Replace the spawn page's history entry if the user is still on it (Back must not reopen the spent form);
      // push if they navigated elsewhere while the spawn was in flight.
      openSpawnedWorker(result.id, repoId);
      loadWorkerHistory(result.id);
      toast.success(tRef.current("toast.workerSpawned"));
    }
  };

  const onRegister = useCallback((r: { name: string; path: string; description: string }) => {
    const c = client; if (!c) return;
    void c.request({ type: "repos.register", ...r }).then(() => c.request({ type: "repos.list" })).then((res) => { useStore.getState().setRepos(res.repos ?? []); toast.success(tRef.current("toast.repoRegistered")); }).catch((e) => toast.error(tRef.current("toast.registerFailed"), String(e)));
  }, []);
  const onRemoveRepo = useCallback((name: string) => {
    const c = client; if (!c) return;
    void c.request({ type: "repos.remove", name }).then(() => { useDraftStore.getState().setSpawnDraft_(name, "", ""); return c.request({ type: "repos.list" }); }).then((res) => { useStore.getState().setRepos(res.repos ?? []); toast.success(tRef.current("toast.repoRemoved")); }).catch((e) => toast.error(tRef.current("toast.actionFailed"), String(e)));
  }, []);
  const onStop = useCallback((id: string) => { void client?.request({ type: "fleet.stop", id }).catch((e) => toast.error(tRef.current("toast.actionFailed"), String(e))); }, []); // RepoTree right-click 'stop'
  const onNewRepo = useCallback(() => setRepoModal(true), []);
  // Repo tree "+": opening the spawn page is a real navigation, so it pushes (the page's own repo select replaces).
  const onNewSub = useCallback((name: string) => {
    const repo = useStore.getState().repos.find((r) => r.name === name);
    if (repo) navigate({ overlay: "spawnWorker", showRepos: true, repoId: repo.id });
  }, [navigate]);
  // Sidebar "New worker" row / rail / Repos home (audit #83): the spawn page for the open worker's repo (else the first
  // repo — the page has its own repo picker); with no repo registered yet, the register dialog.
  const newWorker = useCallback(() => {
    const st = useStore.getState();
    const activePath = st.activeWorkerId ? st.fleet[st.activeWorkerId]?.repoPath : undefined;
    const repo = st.repos.find((r) => r.path === activePath) ?? st.repos[0];
    if (repo) onNewSub(repo.name);
    else setRepoModal(true);
  }, [onNewSub]);
  // Whole-branch diff (fleet.diff) as a read-only tab on the worker's page (audit #84).
  const loadBranchDiff = useCallback((id: string): Promise<string> =>
    client ? client.request({ type: "fleet.diff", id }).then((r) => r.diff ?? "") : Promise.reject(new Error("not connected")), []);
  const openBranchDiff = useCallback((id: string) => {
    const w = useStore.getState().fleet[id];
    useWsStore.getState().openBranchDiff_(id, id, w?.branch ? shortBranch(w.branch) : id.slice(0, 8));
    selectSub(id);
  }, [selectSub]);
  // Rejects on failure (no swallow-to-empty) so CheckpointMenu can render a distinct error state instead of a false "no checkpoints".
  const fetchCheckpoints = (id: string): Promise<Checkpoint[]> =>
    client ? client.request({ type: "worker.checkpoints", id }).then((r) => r.checkpoints ?? []) : Promise.reject(new Error("not connected"));
  // Returns the request promise so CheckpointMenu can await it (loading state, close only on settle). Success gets a toast since
  // the restore doesn't otherwise cause any immediately-visible screen change.
  const onRestore = (id: string, seq: number): Promise<void> =>
    (client ? client.request({ type: "worker.restore", id, seq }) : Promise.reject(new Error("not connected")))
      .then(() => { toast.success(tRef.current("toast.restored")); })
      .catch((e) => { toast.error(tRef.current("toast.actionFailed"), String(e)); throw e; });
  // Returns the request so the Settings page keeps its draft (and stays open on "Save and close") until the daemon
  // accepted it; a failure is reported once here and rethrown for the page (audit #93).
  const saveSettings = useCallback((next: SettingsValues): Promise<void> => {
    const c = client;
    if (!c) { toast.error(tRef.current("toast.saveFailed")); return Promise.reject(new Error("not connected")); }
    return c.request({ type: "settings.set", settings: next }).then((r) => {
      useStore.getState().setSettings(r.settings);
      // A scope change (mcpExposure) reconciles the External MCP server daemon-side → refetch the URL/status.
      void c.request({ type: "mcp.status" }).then((m) => useStore.getState().setMcpStatus({ scope: m.scope, url: m.url })).catch(() => {});
    }, (e) => { toast.error(tRef.current("toast.saveFailed"), String(e)); throw e; });
  }, []);
  // Write-only secret saves (API keys, tokens): resolve once the daemon stored the value — the Settings page clears the
  // field only then (audit #94). The follow-up status refetch runs on its own; its failure isn't a failed save.
  const saveSecret = (patch: Extract<ClientMessage, { type: "settings.set" }>["settings"], refetch?: (c: WsClient) => Promise<void>): Promise<void> => {
    const c = client;
    if (!c) { toast.error(tRef.current("toast.saveFailed")); return Promise.reject(new Error("not connected")); }
    return c.request({ type: "settings.set", settings: patch }).then(() => {
      toast.success(tRef.current("toast.keySaved"));
      if (refetch) void refetch(c).catch(() => {});
    }, (e) => { toast.error(tRef.current("toast.saveFailed"), String(e)); throw e; });
  };
  // Composer attach/drop — reads only the window bridge for stability (avoids a new ref every render → Conversation memo effect).
  const onAttachFile = useCallback(() => window.rookery.pickFile(), []);
  const onDropFiles = useCallback((files: File[]) => files.map((f) => window.rookery.getPathForFile(f)).filter(Boolean), []);
  // @ path autocomplete: list directories relative to the active page's work root (worker worktree > session cwd > home).
  // The file browser is scoped independently from commands.list: subId for a worker page, cwd for a master session.
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
  const capabilityApi = useMemo<CapabilityCenterApi>(() => {
    const connected = (): WsClient => {
      if (!client) throw new Error("daemon not connected");
      return client;
    };
    return {
      loadSnapshot: (target) => connected().request({ type: "capabilities.snapshot", target }).then((response) => response.snapshot),
      loadLibrary: () => connected().request({ type: "capabilities.library" }).then((response) => response.library),
      createMcp: (input) => connected().request({ type: "capabilities.mcp.create", input }).then((response) => ({ pack: response.pack })),
      createSkill: (input) => connected().request({ type: "capabilities.skill.create", input }).then((response) => ({ pack: response.pack })),
      createMcpPack: (input) => connected().request({ type: "capabilities.mcpPack.create", input }).then((response) => ({
        pack: response.pack,
        binding: response.binding,
      })),
      addPack: (sourcePath) => connected().request({ type: "capabilities.pack.add", path: sourcePath }).then((response) => {
        if (!response.pack) throw new Error("capability pack add returned no pack");
        return response.pack;
      }),
      removePack: (instanceId) => connected().request({ type: "capabilities.pack.remove", instanceId }).then(() => undefined),
      setTrust: (instanceId, digest, trusted) => connected().request({ type: "capabilities.trust.set", instanceId, digest, trusted }).then((response) => {
        if (!response.pack) throw new Error("capability trust update returned no pack");
        return response.pack;
      }),
      setSecret: (instanceId, key, value) => connected().request({ type: "capabilities.secret.set", instanceId, key, value }).then((response) => response.secret),
      deleteSecret: (instanceId, key) => connected().request({ type: "capabilities.secret.delete", instanceId, key }).then((response) => response.secret),
      refresh: (instanceId) => connected().request({ type: "capabilities.refresh", ...(instanceId ? { instanceId } : {}) }).then((response) => response.library),
      reloadWorker: (workerId, whenIdle) => connected().request({ type: "capabilities.worker.reload", workerId, whenIdle }).then((response) => ({
        workerId: response.workerId,
        mode: response.mode,
      })),
      setBinding: (id, binding) => connected().request({ type: "capabilities.binding.set", id, binding }).then((response) => {
        if (!response.binding) throw new Error("capability binding update returned no binding");
        return response.binding;
      }),
      quickSetBinding: (input) => connected().request({ type: "capabilities.binding.quickSet", input }).then((response) => response.binding),
      deleteBinding: (id) => connected().request({ type: "capabilities.binding.delete", id }).then(() => undefined),
    };
  }, []);

  const activeSub = s.activeWorkerId ? s.fleet[s.activeWorkerId] : undefined;
  const capabilityTarget: CapabilityTarget | null = showRepos
    ? activeSub ? { kind: "worker", id: activeSub.id } : null
    : s.activeSessionId ? { kind: "session", id: s.activeSessionId } : null;
  const capabilityTargetOptions = useMemo(() => ({
    repos: s.repos.map((repo) => ({ id: repo.id, label: repo.name })),
    sessions: s.sessions.map((session) => ({ id: session.id, label: session.label?.trim() || session.cwd })),
    workers: Object.values(s.fleet).map((worker) => ({ id: worker.id, label: worker.label })),
  }), [s.repos, s.sessions, s.fleet]);
  const repoSettingsRepo = useMemo(() => s.repos.find((repo) => repo.id === s.repoSettingsId) ?? null, [s.repos, s.repoSettingsId]);
  useEffect(() => {
    if (overlay === "repoSettings" && s.fleetLoaded && !repoSettingsRepo) navigate({ overlay: null });
    // same for the spawn page: its repo was unregistered (or a stale restored location) → leave instead of spinning
    if (overlay === "spawnWorker" && s.fleetLoaded && !repoSettingsRepo) navigate({ overlay: null });
  }, [navigate, overlay, repoSettingsRepo, s.fleetLoaded]);
  const fleet = useMemo(() => Object.values(s.fleet), [s.fleet]); // used in RepoTree (Repos view)
  // Master composer model/effort controls — inline would be a new ref every render, breaking the Conversation memo. Keep the same ref
  // across unrelated re-renders like usage polling (deps: settings/active session/overrides only).
  const speedChangeSequence = useRef(new Map<string, SpeedWriteState>());
  const setTargetSpeed = useCallback((kind: "master" | "worker", id: string, speed: SpeedPreference | null) => {
    if (!client) return;
    void persistSpeedPreference(client, kind, id, speed, speedChangeSequence.current)
      .catch((error) => toast.error(tRef.current("toast.saveFailed"), String(error)));
  }, []);
  const masterControls = useMemo(() => {
    if (!(s.settings && s.activeSessionId)) return undefined;
    const provider = s.sessions.find((x) => x.id === s.activeSessionId)?.provider;
    // Codex-aware model/effort/permission resolution lives in the tested pure resolver; here we only add the
    // store-mutating handlers. (Effort re-derivation for finding [23] + bypass-only modes for [2] are in there.)
    const values = resolveMasterControls({
      provider,
      override: s.overrides[s.activeSessionId],
      masterModel: s.settings.masterModel,
      codexMasterModel: s.settings.codexMasterModel,
      masterEffort: s.settings.masterEffort,
      codexModels: s.codexModels,
    });
    return {
      ...values,
      speed: s.sessions.find((x) => x.id === s.activeSessionId)?.speed ?? null,
      defaultSpeed: defaultSpeed(s.settings, provider, "master"),
      onSpeed: (speed: SpeedPreference | null) => setTargetSpeed("master", s.activeSessionId!, speed),
      editable: true,
      onModel: (m: string) => { useStore.getState().invalidateSpeed("master", s.activeSessionId!); useStore.getState().setOverride(s.activeSessionId!, { model: m }); },
      onEffort: (e: string) => useStore.getState().setOverride(useStore.getState().activeSessionId!, { effort: e }),
      onPermissionMode: (m: string) => useStore.getState().setOverride(useStore.getState().activeSessionId!, { permissionMode: m }),
    };
  }, [s.settings, s.activeSessionId, s.overrides, s.sessions, s.codexModels]);
  const activeSess = s.activeSessionId ? s.sessions.find((x) => x.id === s.activeSessionId) : undefined;
  const sessionName = activeSess ? activeSess.label || baseName(activeSess.cwd) || "session" : t("app.selectSession");
  const sessionReadOnly = (s.activeSessionId ? s.sessions.find((x) => x.id === s.activeSessionId)?.origin : undefined) === "slack";

  // Dockable-panes workspace (feature-flagged: rookery.dockable). The render
  // delegates reuse the exact per-page wiring from the static layout below, so
  // behavior is preserved; the dockview panels pull them via WorkspaceRender context.
  const dockable = isDockableEnabled();
  const activeTabPath = activeTab.startsWith("file:") ? activeTab.slice("file:".length) : null;
  // While genuinely still resolving (retries in progress, non-terminal status), a skeleton beats a bare static
  // "locating…" line (audit #17's third leg). A terminal outcome (retries exhausted or the fleet status is
  // terminal) gets an explicit message instead of looping silently (audit #2).
  const workRootFallback =
    wsRootState === "missing" ? (
      <div className="px-3 py-3 text-ui text-muted">{t("rightSidebar.workdirMissing")}</div>
    ) : (
      <SkeletonRows rows={8} />
    );
  const workerControls: ComposerControls | undefined = activeSub ? {
    provider: activeSub.provider,
    speed: activeSub.speed ?? null,
    defaultSpeed: defaultSpeed(s.settings, activeSub.provider, "worker"),
    onSpeed: (speed) => setTargetSpeed("worker", activeSub.id, speed),
    model: activeSub.model ?? (activeSub.provider === "codex" ? s.settings?.codexWorkerModel : s.settings?.workerModel) ?? "claude-opus-4-8",
    editable: workerComposerState(activeSub.status).controlsEditable,
    onModel: (model) => subSetModel(activeSub.id, model),
    permissionMode: activeSub.permissionMode ?? "bypassPermissions",
    onPermissionMode: (mode) => subSetPermissionMode(activeSub.id, mode),
    permissionModes: ["bypassPermissions", "plan"],
  } : undefined;
  const workerRender: WorkspaceRender | null = activeSub
    ? {
        conversation: () => (
          <ConversationPane
            key={activeSub.id}
            kind="worker"
            id={activeSub.id}
            onRetryHistory={retryHistory}
            onSend={(text, images) => subSend(activeSub.id, text, images)}
            onStop={() => subInterrupt(activeSub.id)}
            onRecover={() => subRecover(activeSub.id)}
            onSideStart={(text, images) => startSide("worker", activeSub.id, text, activeSub.model ?? undefined, undefined, images)}
            onSideSend={sendSide}
            onSideStop={stopSide}
            onSideClose={closeSide}
            onCommandAction={handleCommandAction}
            onOpenFile={openFileInPage}
            onAttachFile={onAttachFile}
            onDropFiles={onDropFiles}
            browseDir={browseDir}
            commands={displayCommands}
            controls={workerControls}
            disabled={workerComposerState(activeSub.status).disabled}
            placeholder={t(workerComposerState(activeSub.status).placeholderKey)}
          />
        ),
        editor: (tabId) => <WorkspaceTab activeTab={tabId} pageKey={activeSub.id} root={wsRoot} loadBranchDiff={loadBranchDiff} />,
        terminal: () => <TerminalPanel sessionId={activeSub.id} subId={activeSub.id} cwd={undefined} dock />,
        files: () => (wsRootState === "ready" ? <FileTree root={wsRoot} pageKey={activeSub.id} version={treeVersion} activeTabPath={activeTabPath} /> : workRootFallback),
        git: () => (wsRootState === "ready" ? <GitChanges root={wsRoot} pageKey={activeSub.id} version={treeVersion} onViewBranchDiff={() => openBranchDiff(activeSub.id)} /> : workRootFallback),
        nested: () => <ActivityPanelBody subId={activeSub.id} loadAgentHistory={loadWorkflowAgentHistory} />,
      }
    : null;
  const masterRender: WorkspaceRender | null = s.activeSessionId
    ? {
        conversation: () => (
          <ConversationPane
            key={`${s.activeSessionId ?? "none"}:${composerEpoch}`}
            kind="master"
            id={s.activeSessionId!}
            onRetryHistory={retryHistory}
            onSend={send}
            onOpenFile={openFileInPage}
            onSelectWorker={selectSub}
            onRespond={respondInteraction}
            disabled={sessionReadOnly}
            onStop={stopMaster}
            onSideStart={(text, images) => startSide("master", s.activeSessionId!, text, masterControls?.model, masterControls?.effort, images)}
            onSideSend={sendSide}
            onSideStop={stopSide}
            onSideClose={closeSide}
            onCommandAction={handleCommandAction}
            placeholder={sessionReadOnly ? t("app.slackReadOnly") : t("app.composerPlaceholder")}
            onAttachFile={onAttachFile}
            onDropFiles={onDropFiles}
            browseDir={browseDir}
            commands={displayCommands}
            controls={masterControls}
          />
        ),
        editor: (tabId) => <WorkspaceTab activeTab={tabId} pageKey={s.activeSessionId!} root={wsRoot} />,
        terminal: () => <TerminalPanel sessionId={s.activeSessionId!} subId={null} cwd={activeSess?.cwd} dock />,
        files: () => (wsRootState === "ready" ? <FileTree root={wsRoot} pageKey={s.activeSessionId!} version={treeVersion} activeTabPath={activeTabPath} /> : workRootFallback),
        git: () => (wsRootState === "ready" ? <GitChanges root={wsRoot} pageKey={s.activeSessionId!} version={treeVersion} /> : workRootFallback),
        nested: () => <ActivityPanelBody subId={null} loadAgentHistory={loadWorkflowAgentHistory} />,
      }
    : null;

  // Nav list row (Sessions / Repos): a flat tree-sidebar entry, not a segmented pill — same grammar as the
  // repo-tree/session rows below it. The badge is an inline dot (not something Segment's item shape carries),
  // kept as a plain button here so it stays wired exactly as before.
  const navBtn = (label: string, Icon: typeof MessageSquare, active: boolean, onClick: () => void, badge = false) => (
    <button
      onClick={onClick}
      className={cn(
        "no-drag flex h-[26px] items-center gap-2 rounded-md px-2 text-left text-body transition-colors",
        active ? ROW_SELECTED : "text-muted hover:bg-raised/60 hover:text-fg-dim", // the shared neutral selection (audit #101)
      )}
    >
      <Icon size={14} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {/* dot on the Repos row when there's an unread worker — so even in the Sessions view you notice "something finished". */}
      {badge && <span className="badge-pop h-1.5 w-1.5 shrink-0 rounded-full bg-fg-dim" />}
    </button>
  );

  // Main-area page/overlay swap identifier — the key for replaying rise-in. ⚠️ Derive it only from Location fields (overlay/showRepos/active*).
  // Including high-frequency fields like token/usage/metrics would replay enter on every in-page stream tick,
  // which is worse than static. TerminalPanel sits outside this wrapper (protects the live xterm).
  const pageId = overlay
    ? `ov:${overlay}:${overlay === "repoSettings" || overlay === "spawnWorker" ? s.repoSettingsId ?? "missing" : ""}`
    : s.daemon === "down"
      ? "daemon-down"
      : showRepos
        ? `w:${s.activeWorkerId ?? "none"}`
        : `s:${s.activeSessionId ?? "none"}`;

  return (
    <div className="app-top-inset relative flex h-screen flex-col overflow-hidden bg-ink text-fg">
      <WindowControls />
      {/* The sidebar+main row sits above a full-width status bar (Orca shell anatomy) — min-h-0 so this row (not
          the status bar) absorbs the flex height and stays scrollable internally. */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside
        style={collapsed ? undefined : { width: leftPanel.width }}
        className={cn(
          "sidebar-top relative flex shrink-0 flex-col border-r border-line bg-sunk pt-10",
          // The collapse/expand swap is a width change — never animated (DESIGN: no width/height transitions).
          // A live resize drag also updates width every frame with no transition needed.
          collapsed ? "w-14 items-center gap-2" : "gap-0 px-3 pb-3",
        )}
      >
        {/* the top traffic-light area (pt-10) is a window-move drag region (macOS). On Windows/Linux the dedicated
            title bar handles this, so .win-chrome hides this strip + shrinks the pt (globals.css). */}
        <div className="mac-drag-strip drag absolute inset-x-0 top-0 h-10" />
        {!collapsed && (
          // Same strip as the traffic lights: back/forward + collapse sit at its right edge, using the window-chrome row
          // instead of a second one below it. Back/forward stay at every sidebar width (audit #10; 3 x 24px fit the
          // 220px minimum next to the traffic lights). The attention bell lives in the status bar (audit #19 #20).
          <div className="absolute inset-x-0 top-0 z-20 flex h-10 items-center justify-end gap-0.5 pr-2">
            <button onClick={goBack} disabled={!canBack} aria-label={t("app.back")} title={t("app.back")} className="no-drag flex h-6 w-6 items-center justify-center rounded-md text-muted enabled:hover:bg-raised enabled:hover:text-fg-dim disabled:opacity-25">
              <ChevronLeft size={14} />
            </button>
            <button onClick={goForward} disabled={!canFwd} aria-label={t("app.forward")} title={t("app.forward")} className="no-drag flex h-6 w-6 items-center justify-center rounded-md text-muted enabled:hover:bg-raised enabled:hover:text-fg-dim disabled:opacity-25">
              <ChevronRight size={14} />
            </button>
            <button onClick={toggleSidebar} aria-label={t("app.collapseSidebar")} title={t("app.collapseSidebar")} className="no-drag flex h-6 w-6 items-center justify-center rounded-md text-muted hover:bg-raised hover:text-fg-dim">
              <PanelLeftClose size={14} />
            </button>
          </div>
        )}
        {collapsed ? (
          // Navigation rail (audit #19): expand, history, Sessions/Repos with their unread dots, and the new-item entry
          // for the current view. The status-bar items it used to repeat stay in the status bar.
          <SidebarRail
            onExpand={toggleSidebar}
            onBack={goBack}
            onForward={goForward}
            canBack={canBack}
            canFwd={canFwd}
            view={overlay && overlay !== "newSession" && overlay !== "spawnWorker" ? null : showRepos ? "repos" : "sessions"}
            sessionsUnread={Object.values(s.sessionAttention).some(Boolean)}
            reposUnread={Object.values(s.attention).some(Boolean)}
            onSessions={() => navigate({ overlay: null, showRepos: false })}
            onRepos={() => navigate({ overlay: null, showRepos: true })}
            onNew={showRepos ? newWorker : create}
            newLabel={showRepos ? t("app.newWorker") : t("app.newSession")}
            newActive={overlay === (showRepos ? "spawnWorker" : "newSession")}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col gap-2 pt-2">
            {/* Sessions / Repos — a flat nav list (not a segmented pill track), same row grammar as the tree below it. */}
            <nav className="flex flex-col gap-0.5">
              {navBtn(t("app.navSessions"), MessageSquare, !showRepos && !overlay, () => { navigate({ overlay: null, showRepos: false }); }, Object.values(s.sessionAttention).some(Boolean))}
              {navBtn(t("app.navRepos"), FolderGit2, showRepos && !overlay, () => { navigate({ overlay: null, showRepos: true }); }, Object.values(s.attention).some(Boolean))}
            </nav>
            {/* Sessions view only: quick entry right below the nav list — new session. (Automation lives in the
                always-visible status bar, audit #22 — it's a top-level feature and shouldn't disappear on the Repos tab.) */}
            {!showRepos && (
              <button
                onClick={create}
                className={cn("no-drag flex h-[26px] items-center gap-2 rounded-md px-2 text-left text-body transition-colors", overlay === "newSession" ? ROW_SELECTED : "text-fg-dim hover:bg-raised/60 hover:text-fg")}
              >
                <Plus size={14} className="shrink-0" /> {t("app.newSession")}
              </button>
            )}
            {/* Repos view: the same labelled entry for a new worker (audit #83) — the per-repo + is hover-only now. */}
            {showRepos && (
              <button
                onClick={newWorker}
                className={cn("no-drag flex h-[26px] items-center gap-2 rounded-md px-2 text-left text-body transition-colors", overlay === "spawnWorker" ? ROW_SELECTED : "text-fg-dim hover:bg-raised/60 hover:text-fg")}
              >
                <Plus size={14} className="shrink-0" /> {t("app.newWorker")}
              </button>
            )}
            {showRepos ? (
              <RepoTree repos={s.repos} fleet={fleet} loaded={s.fleetLoaded && s.reposLoaded} loadFailed={(!s.fleetLoaded && s.fleetLoadFailed) || (!s.reposLoaded && s.reposLoadFailed)} onRetry={retryRepoTree} activeSubId={overlay ? null : s.activeWorkerId} onSelectSub={selectSub} onNewRepo={onNewRepo} onRemoveRepo={onRemoveRepo} onNewSub={onNewSub} onRepoSettings={(repoId) => navigate({ overlay: "repoSettings", showRepos: true, repoId })} attention={s.attention} onStopSub={onStop} onRenameSub={renameSub} onForkSub={forkSub} onArchiveSub={archiveSub} onDeleteSub={deleteSub} onViewBranchDiff={openBranchDiff} />
            ) : (
              <Sessions compact={compactSidebar} sessions={s.sessions} loaded={s.sessionsLoaded} loadFailed={s.sessionsLoadFailed} onRetry={loadSessions} activeId={overlay ? null : s.activeSessionId} running={s.running} attention={s.sessionAttention} onSelect={select} onRename={renameSession} onFork={forkSession} onArchive={archiveSession} onDelete={deleteSession} onPin={pinSession} automations={s.automations} filter={s.sessionFilter} onFilter={s.setSessionFilter} />
            )}
          </div>
        )}
      </aside>
      {!collapsed && <ResizeHandle onPointerDown={leftPanel.startDrag} handle={leftPanel.handle} label={t("app.resizeSidebar")} />}

      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-ink">
        {/* The WS dropped (e.g. daemon restart) — the live stream is dead and won't resume until reconnect, so an in-progress
            bubble sits frozen. This strip says "reconnecting" so that reads as a transient reconnect, not a hang. Hidden once up;
            replaced by DaemonDownBanner if it ultimately fails (→ 'down'). */}
        {s.daemon === "starting" && (
          <div className="flex shrink-0 items-center justify-center gap-1.5 border-b border-run/30 bg-run/10 px-3 py-1.5 text-meta font-medium text-run">
            <Loader2 size={12} className="animate-spin" /> {t("app.reconnecting")}
          </div>
        )}
        {/* replay rise-in on every page/overlay swap (key=pageId). Keep TerminalPanel outside this div to preserve the xterm. */}
        <div key={pageId} className="flex min-h-0 flex-1 flex-col rise-in">
        {overlay === "repoSettings" && repoSettingsRepo ? (
          <RepositorySettingsPage
            repo={repoSettingsRepo}
            api={capabilityApi}
            generation={s.capabilityGeneration}
            onClose={closeOverlay}
            onOpenCatalog={openCapabilityCatalog}
            onOpenAdvancedAssignments={openAdvancedCapabilityAssignments}
            onPreviewEffective={() => openRepoCapabilityPreview(repoSettingsRepo.id)}
          />
        ) : overlay === "repoSettings" ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-ui text-muted"><Loader2 size={14} className="animate-spin" /> {t("common.loading")}</div>
        ) : overlay === "spawnWorker" && spawnRepo ? (
          <WorkerSpawnPage
            repo={spawnRepo}
            repos={s.repos}
            onRepoChange={switchSpawnRepo}
            defaultModel={s.settings?.workerModel ?? "claude-opus-4-8"}
            defaultEffort={s.settings?.workerEffort ?? "high"}
            codexDefaultModel={s.settings?.codexWorkerModel || "gpt-6.1-sol"}
            branches={spawnBranches}
            branchesState={spawnBranchesState}
            integrations={s.integrations ?? undefined}
            searchSource={searchSource}
            onSpawn={spawnSub}
            onClose={closeOverlay}
          />
        ) : overlay === "spawnWorker" ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-ui text-muted"><Loader2 size={14} className="animate-spin" /> {t("common.loading")}</div>
        ) : overlay === "capabilities" ? (
          <CapabilitiesPage
            key={capabilityOpenEpoch}
            target={capabilityPreviewTarget ?? capabilityTarget}
            api={capabilityApi}
            targets={capabilityTargetOptions}
            generation={s.capabilityGeneration}
            initialTab={capabilityRoute.tab}
            initialKind={capabilityRoute.kind}
            pickDirectory={() => window.rookery.pickDirectory()}
            onClose={closeOverlay}
          />
        ) : overlay === "settings" && !s.settings ? (
          // settings.get hasn't answered (or failed): the page still opens — skeleton, or the failure with a retry —
          // instead of leaving the old screen up under an active settings button (audit #45).
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="drag flex h-10 shrink-0 items-center gap-2 px-5">
              <h1 className="text-body font-medium text-fg">{t("settings.title")}</h1>
              <Button variant="ghost" size="iconSm" className="no-drag ml-auto" onClick={closeOverlay} aria-label={t("common.close")}><X size={14} /></Button>
            </div>
            {s.settingsLoadFailed
              ? <LoadFailed layout="stack" message={t("app.settingsLoadFailed")} onRetry={loadSettings} />
              : <SkeletonRows rows={8} className="mx-auto w-full max-w-3xl px-6 py-6" />}
          </div>
        ) : overlay === "settings" && s.settings ? (
          <SettingsPage
            settings={s.settings}
            onSave={saveSettings}
            onClose={closeOverlay}
            slack={s.slack}
            onSlackToggle={(enabled) => { void client?.request({ type: "slack.set", enabled }).catch((e) => toast.error(tRef.current("toast.actionFailed"), String(e))); }}
            capabilityApi={capabilityApi}
            capabilityGeneration={s.capabilityGeneration}
            onOpenCapabilityCatalog={openCapabilityCatalog}
            onOpenCapabilityAssignments={openAdvancedCapabilityAssignments}
            onPreviewCapabilities={openRookeryCapabilityPreview}
            integrations={s.integrations}
            authStatus={s.authStatus}
            integrationsFailed={s.integrationsFailed}
            authStatusFailed={s.authStatusFailed}
            onRecheckStatus={() => (client ? requestStatusChecks(client) : Promise.reject(new Error("not connected")))}
            onSaveLinearKey={(key) => saveSecret({ linearApiKey: key }, async (c) => {
              // The Linear key card doesn't otherwise change on screen until integrations.status round-trips (audit #54).
              const r = await c.request({ type: "integrations.status" });
              useStore.getState().setIntegrations({ github: r.github, linear: r.linear });
            })}
            // slack.status arrives via the daemon's live reconcile-on-save broadcast — no extra refetch needed here (audit #8).
            onSaveSlackTokens={(bot, app) => saveSecret({ slackBotToken: bot, slackAppToken: app })}
            onSaveAnthropicKey={(key) => saveSecret({ anthropicApiKey: key }, async (c) => {
              useStore.getState().setAuthStatus(await c.request({ type: "auth.status" }));
            })}
            // Refetch the codex auth probe after saving — the new key provisions the redirected CODEX_HOME, so the
            // Codex sub-tab's readiness card reflects the change (mirrors onSaveAnthropicKey).
            onSaveCodexKey={(key) => saveSecret({ codexApiKey: key }, async (c) => {
              const r = await c.request({ type: "codex.authStatus" });
              useStore.getState().setCodexAuthStatus(r.status ?? "unavailable");
            })}
            mcpStatus={s.mcpStatus}
            onRegenerateMcpToken={() => {
              void client?.request({ type: "mcp.regenerate_token" })
                .then((r) => { useStore.getState().setMcpStatus({ scope: r.scope, url: r.url }); toast.success(tRef.current("toast.mcpTokenRegenerated")); })
                .catch((e) => toast.error(tRef.current("toast.actionFailed"), String(e)));
            }}
          />
        ) : overlay === "newSession" ? (
          <NewSessionPage repos={s.repos} reposLoaded={s.reposLoaded} defaultModel={s.settings?.masterModel ?? "claude-opus-4-8"} defaultEffort={s.settings?.masterEffort ?? "high"} codexDefaultModel={s.settings?.codexMasterModel || "gpt-6.1-sol"} onStart={startSession} onClose={closeOverlay} browseDir={newSessionBrowse} loadCommands={loadNewSessionCommands} onAttachFile={onAttachFile} onDropFiles={onDropFiles} authStatus={s.authStatus} onOpenSettings={() => navigate({ overlay: "settings" })} defaultFolder={s.settings?.defaultSessionCwd} onRegisterRepo={onNewRepo} />
        ) : overlay === "automation" ? (
          editJob ? (
            <AutomationForm
              job={editJob}
              repos={s.repos}
              commands={displayCommands.filter((command) => command.action.type === "insert-prompt")}
              browseDir={newSessionBrowse}
              onClose={() => setEditJob(null)}
              onSubmit={async (input) => {
                const msg =
                  editJob === "new"
                    ? ({ type: "automation.create" as const, automation: input })
                    : ({ type: "automation.update" as const, id: editJob.id, patch: input });
                // A failure is shown once, inline under the form header (AutomationForm's submitError) — no toast too.
                if (!client) throw new Error(tRef.current("toast.saveFailed"));
                await client.request(msg);
                setEditJob(null);
              }}
            />
          ) : (
            <AutomationPage
              onClose={closeOverlay}
              automations={s.automations}
              loaded={s.automationsLoaded}
              loadFailed={s.automationsLoadFailed}
              onRetry={refetchAutomations}
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
              onDelete={(id) => {
                // Returned so the page can bring back its optimistically removed row if the delete fails.
                const req = client?.request({ type: "automation.delete", id });
                if (!req) { toast.error(tRef.current("toast.deleteFailed")); return Promise.reject(new Error("not connected")); }
                return req.then(() => {}, (e) => { toast.error(tRef.current("toast.deleteFailed"), String(e)); throw e; });
              }}
              onEdit={(job) => setEditJob(job)}
              onNew={() => setEditJob("new")}
              onViewSessions={(id) => { s.setSessionFilter({ source: "automation", automationId: id }); navigate({ overlay: null, showRepos: false }); }}
              onResolveSlackRefs={(channels, users) => {
                // Best-effort (audit #51): no client, a disconnected/unconfigured Slack adapter, or any daemon-side lookup
                // failure all resolve to empty maps — AutomationPage's own fallback then keeps showing the raw ids.
                const req = client?.request({ type: "automation.resolveSlackRefs", channels, users });
                return req ? req.then((r) => ({ channels: r.channels ?? {}, users: r.users ?? {} }), () => ({ channels: {}, users: {} })) : Promise.resolve({ channels: {}, users: {} });
              }}
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
                  onStopTask={(taskId) => subStopTask(activeSub.id, taskId)}
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
                onStopTask={(taskId) => subStopTask(activeSub.id, taskId)}
              />
              <div className="flex min-h-0 flex-1">
                <div className="flex min-w-0 flex-1 flex-col">
                  {termPageKey && <TabBar pageKey={termPageKey} agentLabel={showRepos ? t("app.worker") : t("app.master")} />}
                  {activeTab === "agent" ? (
                    <ConversationPane
                      key={activeSub.id}
                      kind="worker"
                      id={activeSub.id}
                      onRetryHistory={retryHistory}
                      onSend={(text, images) => subSend(activeSub.id, text, images)}
                      onStop={() => subInterrupt(activeSub.id)}
                      onRecover={() => subRecover(activeSub.id)}
                      onSideStart={(text, images) => startSide("worker", activeSub.id, text, activeSub.model ?? undefined, undefined, images)}
                      onSideSend={sendSide}
                      onSideStop={stopSide}
                      onSideClose={closeSide}
                      onCommandAction={handleCommandAction}
                      onOpenFile={openFileInPage}
                      onAttachFile={onAttachFile}
                      onDropFiles={onDropFiles}
                      browseDir={browseDir}
                      commands={displayCommands}
                      controls={workerControls}
                      disabled={workerComposerState(activeSub.status).disabled}
                      placeholder={t(workerComposerState(activeSub.status).placeholderKey)}
                    />
                  ) : (
                    <WorkspaceTab activeTab={activeTab} pageKey={termPageKey!} root={wsRoot} loadBranchDiff={loadBranchDiff} />
                  )}
                </div>
              </div>
            </>
            )
          ) : (
            <ReposHome hasRepos={s.repos.length > 0} loaded={s.reposLoaded} onNewWorker={newWorker} onNewRepo={onNewRepo} />
          )
        ) : !s.activeSessionId && restorePending && !s.sessionsLoadFailed && !s.fleetLoadFailed ? (
          <div className="flex min-h-0 flex-1 flex-col justify-center px-6" aria-busy="true">
            <SkeletonRows rows={5} />
          </div>
        ) : !s.activeSessionId ? (
          // when no session is selected (first run, etc.), default to the new-session screen instead of a blank screen.
          <NewSessionPage repos={s.repos} reposLoaded={s.reposLoaded} defaultModel={s.settings?.masterModel ?? "claude-opus-4-8"} defaultEffort={s.settings?.masterEffort ?? "high"} codexDefaultModel={s.settings?.codexMasterModel || "gpt-6.1-sol"} onStart={startSession} browseDir={newSessionBrowse} loadCommands={loadNewSessionCommands} onAttachFile={onAttachFile} onDropFiles={onDropFiles} authStatus={s.authStatus} onOpenSettings={() => navigate({ overlay: "settings" })} defaultFolder={s.settings?.defaultSessionCwd} onRegisterRepo={onNewRepo} />
        ) : dockable && masterRender ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <SessionHeader
              name={sessionName}
              sessionId={s.activeSessionId}
              cwd={activeSess?.cwd}
              provider={activeSess?.provider}
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
              provider={activeSess?.provider}
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
                onRetryHistory={retryHistory}
                onSend={send}
                onOpenFile={openFileInPage}
                onSelectWorker={selectSub}
                onRespond={respondInteraction}
                disabled={sessionReadOnly}
                onStop={stopMaster}
                onSideStart={(text, images) => startSide("master", s.activeSessionId!, text, masterControls?.model, masterControls?.effort, images)}
                onSideSend={sendSide}
                onSideStop={stopSide}
                onSideClose={closeSide}
                onCommandAction={handleCommandAction}
                placeholder={sessionReadOnly ? t("app.slackReadOnly") : t("app.composerPlaceholder")}
                onAttachFile={onAttachFile}
                onDropFiles={onDropFiles}
                browseDir={browseDir}
                commands={displayCommands}
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
        <RightSidebar open={rightVisible} pageKey={termPageKey} subId={showRepos ? s.activeWorkerId : null} cwd={showRepos ? undefined : activeSess?.cwd} activeTabPath={activeTab.startsWith("file:") ? activeTab.slice("file:".length) : null} loadAgentHistory={loadWorkflowAgentHistory} />
      )}
      </div>
      <StatusBar
        daemon={s.daemon}
        daemonStatusText={daemonStatusText}
        daemonJustUp={daemonJustUp}
        slack={s.slack}
        slackStatusText={slackStatusText}
        slackJustUp={slackJustUp}
        usage={s.usage}
        usageLoadFailed={s.usageLoadFailed}
        usageEmpty={s.usageEmpty}
        resources={resources}
        resourcesFailed={resourcesFailed}
        onResourceRefresh={pollResourcesOnce}
        onResourceOpenChange={setResOpen}
        notifyOn={notifyOn}
        onToggleNotify={toggleNotify}
        capabilityActive={overlay === "capabilities"}
        onToggleCapabilityCenter={toggleCapabilityCenter}
        automationActive={overlay === "automation"}
        onToggleAutomation={() => navigate({ overlay: overlay === "automation" ? null : "automation" })}
        settingsActive={overlay === "settings"}
        onToggleSettings={() => navigate({ overlay: overlay === "settings" ? null : "settings" })}
        restarting={restarting}
        onRestart={() => setRestartConfirm(true)}
        onAttentionNav={onAttentionNav}
        routeKey={pageId}
      />

      <Toaster />
      {restartConfirm && <RestartDaemonDialog busy={restarting} onClose={() => setRestartConfirm(false)} onConfirm={() => void doRestart()} />}
      {repoModal && <RepoModal repos={s.repos} onRegister={onRegister} onClose={() => setRepoModal(false)} />}
      {forkTarget && (
        <ForkDialog
          kind={forkTarget.kind}
          sourceProvider={forkTarget.sourceProvider}
          onFork={(target) => (forkTarget.kind === "master" ? runForkSession(forkTarget.id, target) : runForkSub(forkTarget.id, target))}
          onClose={() => setForkTarget(null)}
        />
      )}
      {/* onAccept RETURNS the request promise (rather than swallowing it) so the modal itself can show busy/error
          feedback on failure — it only mounts once daemon==="up", at which point `client` is guaranteed set. The
          visibility gate lives here (not inside the component) so the panel exists on first mount and
          useFocusTrap's effect actually attaches (mirrors the OnboardingModal/RepoModal precedent below). */}
      {s.daemon === "up" && s.settings && s.settings.hasAcceptedDataNotice !== "1" && (
        <DataConsentModal
          onAccept={() =>
            client!.request({ type: "settings.set", settings: { hasAcceptedDataNotice: "1" } })
              .then(() => useStore.getState().setSettings({ ...useStore.getState().settings!, hasAcceptedDataNotice: "1" }))
          }
        />
      )}
      {/* Onboarding (after consent, before all-set): welcome+concept modal, then a non-blocking Getting Started card. */}
      {s.daemon === "up" && s.settings && s.settings.hasAcceptedDataNotice === "1" && s.settings.onboardingDone !== "1" && (
        <OnboardingModal
          onFinish={() =>
            client!.request({ type: "settings.set", settings: { onboardingDone: "1" } })
              .then(() => useStore.getState().setSettings({ ...useStore.getState().settings!, onboardingDone: "1" }))
          }
        />
      )}
      {(() => {
        if (s.daemon !== "up" || !s.settings || s.settings.onboardingDone !== "1" || gsDismissed) return null;
        const authDone = !!s.authStatus && s.authStatus.method !== "none";
        const folderDone = !!s.settings.defaultSessionCwd;
        const sessionDone = s.sessions.length > 0;
        const workerDone = Object.keys(s.fleet).length > 0; // any worker ever spawned (fleet.list includes terminated rows)
        if (authDone && folderDone && sessionDone && workerDone) return null; // all set → no nag
        return (
          <GettingStartedChecklist
            authDone={authDone}
            folderDone={folderDone}
            sessionDone={sessionDone}
            workerDone={workerDone}
            onAuth={() => navigate({ overlay: "settings" })}
            onFolder={() => { void window.rookery.pickDirectory().then((dir) => { if (dir) void client?.request({ type: "settings.set", settings: { defaultSessionCwd: dir } }).then((r) => useStore.getState().setSettings(r.settings)).catch(() => {}); }); }}
            onSession={() => create()}
            onWorker={suggestFirstWorker}
            onDismiss={() => setGsDismissed(true)}
          />
        );
      })()}
    </div>
  );
}
