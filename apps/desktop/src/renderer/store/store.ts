import { create } from "zustand";
import type { CoreEvent, WorkerEventData, SlackStatus } from "@daemon/core/events.js";
import type { UsageSnapshot } from "@daemon/core/usage.js";
import type { SettingsValues } from "@daemon/core/settings.js";
import type { IntegrationsStatus, WorkerRow } from "@daemon/protocol/messages.js";
import type { AuthStatus } from "@daemon/core/auth-status.js";
import type { Automation } from "@daemon/persistence/repositories.js";
import { emptyState, reduceEvent, applySubEvent, seedSessionLog } from "./reduce.js";
import type { AppState, FleetRow, LogItem } from "./reduce.js";
import { navigate as navGo, back as navBackFn, forward as navFwdFn, reset as navReset } from "./navigation.js";
import type { Location, Overlay, NavState } from "./navigation.js";
import { MODELS } from "../lib/models.js";
import type { ModelOption } from "../lib/models.js";

interface Store extends AppState {
  sessions: Array<{ id: string; cwd: string; status: string; lastActivity: string; origin: string; originRef?: string | null; label?: string | null; archived?: boolean; pinned?: boolean }>;
  // ── Single location (navigation) model — overlay/showRepos/activeSessionId/activeWorkerId together form one Location.
  // All transitions go through navigate/goBack/goForward (browser-style history). canBack/Fwd derive from navBack/navFwd.length.
  overlay: Overlay; // Main-area full page (settings/new session/automation) — null means the normal session/Repos view
  showRepos: boolean; // Sessions ↔ Repos
  activeSessionId: string | null;
  activeWorkerId: string | null;
  navBack: Location[];
  navFwd: Location[];
  navigate: (patch: Partial<Location>) => void;
  goBack: () => void;
  goForward: () => void;
  restoreLocation: (loc: Location) => void; // Set location without pushing history (restore entry)
  // Whether the initial lists have arrived at least once — prevents state restore/prune from running before fleet arrives and wiping the worker page.
  sessionsLoaded: boolean;
  fleetLoaded: boolean;
  repos: Array<{ name: string; path: string; description: string; base: string | null }>;
  daemon: "up" | "down" | "starting";
  daemonNote: string | null; // Specific cause of daemon down (e.g. Node ABI mismatch) — shown in the banner when present
  slack: SlackStatus;
  usage: UsageSnapshot | null;
  setUsage: (usage: UsageSnapshot) => void;
  settings: SettingsValues | null;
  setSettings: (settings: SettingsValues) => void;
  // List of available models (live from the daemon's models.list, or the static fallback). Shared by the settings, spawn, and session model pickers.
  models: ModelOption[];
  setModels: (models: ModelOption[]) => void;
  // Linear/GitHub integration connection status (on-demand pull). Used by the spawn dialog and the settings integrations section.
  integrations: IntegrationsStatus | null;
  setIntegrations: (i: IntegrationsStatus) => void;
  // Active Claude auth (api key vs subscription OAuth) — shown in Settings → Claude.
  authStatus: AuthStatus | null;
  setAuthStatus: (a: AuthStatus) => void;
  // Per-UI-session model/effort/permissionMode overrides (independent of the default settings). Unset keys fall back to the global defaults.
  overrides: Record<string, { model?: string; effort?: string; permissionMode?: string }>;
  setOverride: (sid: string, patch: { model?: string; effort?: string; permissionMode?: string }) => void;
  // Slash command/skill candidates for the currently active conversation pane (refreshed when the context changes).
  commands: Array<{ name: string; description: string; argumentHint?: string; aliases?: string[] }>;
  setCommands: (commands: Store["commands"]) => void;
  // Workers that settled (idle/done/error/failed) while the user wasn't looking = unread. Cleared when opened (select) or when running again.
  attention: Record<string, boolean>;
  // Whether a master turn is in progress (per session) — server-authoritative via the agent.status event. Unlike busy (optimistic, this-window-only), it reflects across all clients.
  running: Record<string, boolean>;
  // On reconnect, seed the running indicator from the persisted status in session.list (restore the initial state without missing events). Only once, on connect.
  seedRunningFromSessions: (sessions: { id: string; status: string }[]) => void;
  // Sessions whose turn ended (idle) while not being looked at = unread. The session-side counterpart of worker attention (a separate map — so it isn't swept by the setFleet prune).
  sessionAttention: Record<string, boolean>;
  // requestIds of interaction cards the daemon has announced since the last (re)connect (see the store creator).
  liveInteractionIds: Set<string>;
  resetLiveInteractions: () => void;
  applyEvent: (e: CoreEvent) => void;
  setSessions: (s: Store["sessions"]) => void;
  setActive: (id: string) => void;
  setActiveSub: (id: string | null) => void;
  // Accepts the protocol fleet shape (permissionMode optional/absent) — the impl defaults permissionMode to bypassPermissions when missing.
  setFleet: (rows: Array<WorkerRow & { archived?: boolean }>) => void;
  automations: Automation[];
  setAutomations: (automations: Automation[]) => void;
  // Sessions source-segment state — held in the store so AutomationPage cross-links can set it from outside.
  sessionFilter: { source: "all" | "ui" | "slack" | "automation"; automationId?: string | null };
  setSessionFilter: (f: Store["sessionFilter"]) => void;
  setRepos: (r: Store["repos"]) => void;
  setDaemon: (d: Store["daemon"]) => void;
  setDaemonNote: (note: string | null) => void;
  seedHistory: (sid: string, events: Array<{ seq: number; type: string; payload: unknown; createdAt?: string }>) => void;
  seedWorkerHistory: (id: string, events: Array<{ seq: number; type: string; payload: unknown; createdAt?: string }>) => void;
  // Optimistic "pending" bubble for a message sent while a worker is busy. Reconciled to committed when the worker.event user echo (clientMsgId) arrives.
  pushWorkerPending: (id: string, item: { clientMsgId: string; text: string }) => void;
  // Add an optimistic pending bubble on the App send path. Transitioned to committed via isEchoUser dedup when the daemon user echo (master.message role=user) arrives.
  pushPending: (sid: string, item: { clientMsgId: string; text: string }) => void;
}

// DSK-7: Persist per-session overrides to localStorage (kept across reloads) + clean up overrides for sessions that no longer exist.
const OVERRIDES_KEY = "rookery:overrides";
type Overrides = Record<string, { model?: string; effort?: string; permissionMode?: string }>;
function loadOverrides(): Overrides {
  try { return JSON.parse(globalThis.localStorage?.getItem(OVERRIDES_KEY) ?? "{}") as Overrides; } catch { return {}; }
}
function saveOverrides(o: Overrides): void {
  try { globalThis.localStorage?.setItem(OVERRIDES_KEY, JSON.stringify(o)); } catch { /* ignore */ }
}

// Reconstruct the current location from the store's flat fields / spread a NavState into flat fields.
const locOf = (s: Store): Location => ({ overlay: s.overlay, showRepos: s.showRepos, sessionId: s.activeSessionId, subId: s.activeWorkerId });
const spreadNav = (nav: NavState) => ({ overlay: nav.loc.overlay, showRepos: nav.loc.showRepos, activeSessionId: nav.loc.sessionId, activeWorkerId: nav.loc.subId, navBack: nav.back, navFwd: nav.forward });

export const useStore = create<Store>((set, get) => ({
  ...emptyState(),
  sessions: [], activeSessionId: null, activeWorkerId: null, sessionsLoaded: false, fleetLoaded: false, repos: [], daemon: "starting",
  overlay: null, showRepos: false, navBack: [], navFwd: [],
  navigate: (patch) => set((s) => {
    const nav = navGo({ loc: locOf(s), back: s.navBack, forward: s.navFwd }, patch);
    // Clear unread on the explicitly navigated-to session/worker (the old setActive/setActiveSub semantics).
    const sessionAttention = patch.sessionId ? { ...s.sessionAttention, [patch.sessionId]: false } : s.sessionAttention;
    const attention = patch.subId ? { ...s.attention, [patch.subId]: false } : s.attention;
    return { ...spreadNav(nav), sessionAttention, attention };
  }),
  goBack: () => set((s) => spreadNav(navBackFn({ loc: locOf(s), back: s.navBack, forward: s.navFwd }))),
  goForward: () => set((s) => spreadNav(navFwdFn({ loc: locOf(s), back: s.navBack, forward: s.navFwd }))),
  restoreLocation: (loc) => set(() => spreadNav(navReset(loc))),
  daemonNote: null,
  slack: "connecting",
  usage: null,
  setUsage: (usage) => set({ usage }),
  settings: null,
  setSettings: (settings) => set({ settings }),
  models: [...MODELS], // Initialize with the static fallback (no flicker) → swapped to live when models.list arrives
  setModels: (models) => set({ models: models.length ? models : [...MODELS] }),
  integrations: null,
  setIntegrations: (integrations) => set({ integrations }),
  authStatus: null,
  setAuthStatus: (authStatus) => set({ authStatus }),
  overrides: loadOverrides(),
  setOverride: (sid, patch) => set((s) => { const overrides = { ...s.overrides, [sid]: { ...s.overrides[sid], ...patch } }; saveOverrides(overrides); return { overrides }; }),
  commands: [],
  setCommands: (commands) => set({ commands }),
  attention: {},
  running: {},
  // Authoritative seed: since session.list is the truth, explicitly set each session's running flag (even bringing a stale true down to false). Restores missed idle on reconnect.
  seedRunningFromSessions: (sessions) => set((s) => { const running = { ...s.running }; for (const x of sessions) running[x.id] = x.status === "running"; return { running }; }),
  sessionAttention: {},
  // requestIds of interaction cards the daemon has announced since the last (re)connect. Reset in App's ws
  // onOpen BEFORE events.subscribe; the daemon's synchronous pending-card replay then repopulates it, so at
  // seed time "not in this set" means the daemon no longer holds that request (expired).
  liveInteractionIds: new Set<string>(),
  resetLiveInteractions: () => set(() => ({ liveInteractionIds: new Set<string>() })),
  applyEvent: (e) =>
    set((s) => {
      const now = Date.now(); // Live message arrival time (for hover relative time) — an impure boundary, injected as an argument into the pure reduce.
      // The session-label auto-generation event updates the session list (store level) directly (reduce only deals with AppState).
      if (e.type === "session.label") {
        return { sessions: s.sessions.map((x) => (x.id === e.sessionId ? { ...x, label: e.label } : x)) };
      }
      // The SDK pushes a change to the command/skill list → if it's the context currently being viewed, swap the / candidates.
      if (e.type === "commands.changed") {
        return e.scopeId === s.activeWorkerId || e.scopeId === s.activeSessionId ? { commands: e.commands } : {};
      }
      // Slack status update.
      if (e.type === "slack.status") {
        return { slack: e.status };
      }
      // (busy map retired: the composer's "in progress" is derived by ConversationPane from running ‖ pending. Turn end is when master.status:idle turns running off.)
      // Master turn-in-progress state → running map (live pulse) + unread (if it ends as idle while not being looked at, sessionAttention).
      if (e.type === "master.status") {
        const running = { ...s.running, [e.sessionId]: e.status === "running" };
        if (e.status === "idle" && e.sessionId !== s.activeSessionId) {
          return { running, sessionAttention: { ...s.sessionAttention, [e.sessionId]: true } };
        }
        if (e.status === "running") return { running, sessionAttention: { ...s.sessionAttention, [e.sessionId]: false } };
        return { running };
      }
      // A worker settled while the user wasn't looking → mark unread (attention). Not marked if being viewed; cleared when running resumes.
      if (e.type === "worker.status") {
        const base = reduceEvent(s, e, now);
        if (e.workerId === s.activeWorkerId) return base; // The worker currently being viewed isn't unread
        if (e.status === "idle" || e.status === "done" || e.status === "error" || e.status === "failed") {
          return { ...base, attention: { ...s.attention, [e.workerId]: true } };
        }
        if (e.status === "running") return { ...base, attention: { ...s.attention, [e.workerId]: false } };
        return base;
      }
      // Record every interaction card the daemon announces (fresh live card OR events.subscribe replay) so seed
      // time can tell live-from-dead. reduceEvent stays the single log-mutation authority (it dedups by requestId).
      const patch = reduceEvent(s, e, now);
      if (e.type === "interaction.request") return { ...patch, liveInteractionIds: new Set(s.liveInteractionIds).add(e.requestId) };
      return patch;
    }),
  setSessions: (sessions) => set((s) => {
    // Clean up overrides for sessions that no longer exist to prevent unbounded accumulation (DSK-7).
    const ids = new Set(sessions.map((x) => x.id));
    const overrides = Object.fromEntries(Object.entries(s.overrides).filter(([k]) => ids.has(k)));
    if (Object.keys(overrides).length !== Object.keys(s.overrides).length) saveOverrides(overrides);
    // Also clean up unread for deleted sessions (so a tab badge doesn't stay lit).
    const sessionAttention = Object.fromEntries(Object.entries(s.sessionAttention).filter(([k]) => ids.has(k)));
    // Also clean up running for sessions that vanished (A4) — otherwise a deleted/archived running session lingers in the map forever.
    const running = Object.fromEntries(Object.entries(s.running).filter(([k]) => ids.has(k)));
    return { sessions, overrides, sessionAttention, running, sessionsLoaded: true };
  }),
  // setActive/setActiveSub are thin aliases over navigate (navigate handles clearing unread). Just patch the id.
  setActive: (id) => get().navigate({ sessionId: id }),
  setActiveSub: (id) => get().navigate({ subId: id }),
  // Clean up unread entries for workers that vanished (so a tab badge doesn't stay lit after delete/discard).
  // Prune vanished workers. Even for those that remain, if non-running, clear pending (A6: prevent ghost "pending" bubbles for settled workers on reconnect) — preserved only while running.
  setFleet: (rows) => set((s) => ({ fleet: Object.fromEntries(rows.map((r) => [r.id, { ...r, permissionMode: r.permissionMode ?? "bypassPermissions" }])), fleetLoaded: true, attention: Object.fromEntries(Object.entries(s.attention).filter(([k]) => rows.some((r) => r.id === k))), pendingByWorker: Object.fromEntries(Object.entries(s.pendingByWorker).filter(([k]) => rows.some((r) => r.id === k && r.status === "running"))) })),
  automations: [],
  setAutomations: (automations) => set({ automations }),
  sessionFilter: { source: "ui" }, // Default to the isolated view (your own UI sessions) — so externally-driven Slack/automation sessions aren't mixed in by default. If empty, falls back to the first existing source.
  setSessionFilter: (sessionFilter) => set({ sessionFilter }),
  setRepos: (repos) => set({ repos }),
  setDaemon: (daemon) => set({ daemon }),
  setDaemonNote: (daemonNote) => set({ daemonNote }),
  seedHistory: (sid, events) => set((s) => ({ logsBySession: { ...s.logsBySession, [sid]: seedSessionLog(s.logsBySession[sid], sid, events, s.liveInteractionIds) } })),
  pushWorkerPending: (id, item) => set((s) => ({ pendingByWorker: { ...s.pendingByWorker, [id]: [...(s.pendingByWorker[id] ?? []), item] } })),
  pushPending: (sid, item) => set((s) => ({ pendingBySession: { ...s.pendingBySession, [sid]: [...(s.pendingBySession[sid] ?? []), item] } })),
  seedWorkerHistory: (id, events) =>
    set((s) => ({
      workerLogs: {
        ...s.workerLogs,
        [id]: events.reduce<LogItem[]>((log, ev) => applySubEvent(log, ev.payload as WorkerEventData, ev.createdAt ? Date.parse(ev.createdAt) : undefined), []),
      },
    })),
}));
