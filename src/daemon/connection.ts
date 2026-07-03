import { randomUUID } from "node:crypto";
import type { SessionManager } from "../core/session-manager.js";
import { UI_FLEET_SESSION_KEY } from "../core/session-manager.js";
import type { EventBus, CoreEvent } from "../core/events.js";
import { FLEET_CHANNEL, ALL_CHANNEL } from "../core/events.js";
import type { FleetOrchestrator } from "../core/fleet-orchestrator.js";
import { isSafeGitRef } from "../core/git-ref.js";
import { getAuthStatus } from "../core/auth-status.js";
import { defaultTokenReader } from "../core/oauth-usage.js";
import { parseClientMessage, serializeServerMessage } from "../protocol/messages.js";
import type { ServerMessage } from "../protocol/messages.js";
import type { Repositories } from "../persistence/repositories.js";
import type { Automation, AutomationInput } from "../persistence/repositories.js";
import type { UsageSnapshot } from "../core/usage.js";
import { emptyUsage } from "../core/usage.js";
import type { SettingsValues, SettingsPatch } from "../core/settings.js";
import { applyApiKeyToEnv } from "../core/settings.js";
import type { SlashCommandInfo } from "../core/commands.js";
import type { SourceItem, SourceProviderId } from "../core/source-intake.js";
import type { IntegrationsStatus } from "../protocol/messages.js";
import type { SlackController } from "../slack/controller.js";
import type { ModelInfo } from "../core/models-provider.js";
import { STATIC_MODELS } from "../core/models-provider.js";
import type { ActionVars } from "../core/automation-action.js";

export interface UsageProvider {
  snapshot(): UsageSnapshot;
}

export interface ModelsProvider {
  list(): Promise<ModelInfo[]>; // Available Claude models (for the settings model picker). Always non-empty (live or static fallback).
}

export interface SettingsProvider {
  all(): SettingsValues;
  apply(patch: SettingsPatch): SettingsValues;
  setLinearApiKey(key: string | undefined): void;
  setAnthropicApiKey(key: string | undefined): void;
  anthropicApiKey(): string | undefined;
  setSlackBotToken(token: string | undefined): void;
  setSlackAppToken(token: string | undefined): void;
}

export interface CommandProvider {
  forCwd(cwd: string): Promise<SlashCommandInfo[]>;
}

export interface SourceProvider {
  listBranches(repoPath: string): Promise<string[]>;
  fetchSource(url: string): Promise<{ title: string; body: string } | null>;
  searchSource(provider: SourceProviderId, query: string, repoPath?: string): Promise<SourceItem[]>;
  integrationsStatus(): Promise<IntegrationsStatus>;
}

// Router for master canUseTool (approval/AskUserQuestion) responses (= InteractionRegistry). Resolves WS interaction.respond.
export interface InteractionResponder {
  respond(requestId: string, res: { decision?: "allow" | "deny"; answers?: Record<string, string | string[]> }): { ok: boolean };
  // Live pending interactions (optionally for one session) as replayable events — so a (re)subscribing client rehydrates
  // any open approval/AskUserQuestion card instead of leaving the held master turn hung after a full reload.
  pendingEvents(sessionId?: string): CoreEvent[];
}

export interface AutomationProvider {
  list(): Automation[];
  create(input: AutomationInput): Automation;
  update(id: string, patch: AutomationInput): Automation | undefined;
  delete(id: string): void;
  setEnabled(id: string, enabled: boolean): Automation | undefined;
  runNow(id: string, vars?: ActionVars): Promise<void>;
}

export interface ClientSocket {
  send(data: string): void;
}

export class Connection {
  private readonly unsubs = new Map<string, () => void>();

  constructor(
    private readonly socket: ClientSocket,
    private readonly sessions: SessionManager,
    private readonly bus: EventBus,
    private readonly fleet: FleetOrchestrator,
    private readonly repos: Repositories,
    private readonly usage?: UsageProvider,
    private readonly settings?: SettingsProvider,
    private readonly commands?: CommandProvider,
    private readonly source?: SourceProvider,
    private readonly slack?: SlackController,
    private readonly models?: ModelsProvider,
    private readonly interactions?: InteractionResponder,
    private readonly automations?: AutomationProvider,
  ) {}

  private reply(msg: ServerMessage): void {
    this.socket.send(serializeServerMessage(msg));
  }

  private subscribe(key: string): void {
    if (this.unsubs.has(key)) return;
    // If already subscribed to @all, an individual session/fleet subscription is redundant (double delivery on the same socket), so skip it.
    if (key !== ALL_CHANNEL && this.unsubs.has(ALL_CHANNEL)) return;
    // @all receives every event → existing individual session/fleet subscriptions would double-deliver, so unsubscribe them.
    // (Previously dedup was only one-directional, so subscribing to a session/fleet first and then adding @all delivered events twice.)
    if (key === ALL_CHANNEL) {
      for (const [k, off] of this.unsubs) {
        if (k !== ALL_CHANNEL) { off(); this.unsubs.delete(k); }
      }
    }
    const off = this.bus.subscribe(key, (event: CoreEvent) => {
      this.reply({ type: "event", event });
    });
    this.unsubs.set(key, off);
  }

  async handleRaw(raw: string): Promise<void> {
    let msg;
    try {
      msg = parseClientMessage(raw);
    } catch (err) {
      // Best-effort reqId echo: the frame failed schema validation so `msg` never existed, but if the raw JSON
      // carried a reqId the client has a pending request() that would otherwise hang forever (the desktop's
      // WsClient drops error frames without a reqId). Reachable via e.g. an invalid cron in automation.create.
      let reqId: string | undefined;
      try { const j = JSON.parse(raw) as { reqId?: unknown }; if (typeof j.reqId === "string") reqId = j.reqId; } catch { /* not JSON at all */ }
      this.reply({ type: "error", message: `invalid message: ${String(err)}`, ...(reqId ? { reqId } : {}) });
      return;
    }

    // If a handler throws (e.g. duplicate repo registration → UNIQUE violation), respond with error+reqId.
    // Otherwise the void-ed handleRaw rejects and the client's request() hangs forever.
    try {
    switch (msg.type) {
      case "session.create": {
        // No explicit cwd (desktop "New Session" with no folder picked) → the configured default folder, else process.cwd().
        const session = this.sessions.create(msg.cwd ?? (this.settings?.all().defaultSessionCwd?.trim() || process.cwd()));
        this.subscribe(session.id);
        this.reply({ type: "session.created", sessionId: session.id, cwd: session.cwd, ...(msg.reqId ? { reqId: msg.reqId } : {}) });
        return;
      }
      case "session.open": {
        // find-or-create by external key (e.g. Slack thread_ts). Same key → always the same session.
        const session = this.sessions.getOrCreateByKey(msg.key, msg.cwd ?? process.cwd());
        this.subscribe(session.id);
        this.reply({ type: "session.created", sessionId: session.id, cwd: session.cwd, ...(msg.reqId ? { reqId: msg.reqId } : {}) });
        return;
      }
      case "session.fork": {
        // Fork a master session → a new session with the original's SDK context + copied transcript. Replies like session.create so the client navigates to it.
        try {
          const session = await this.sessions.fork(msg.sessionId);
          this.subscribe(session.id);
          this.reply({ type: "session.created", sessionId: session.id, cwd: session.cwd, ...(msg.reqId ? { reqId: msg.reqId } : {}) });
        } catch (err) {
          this.reply({ type: "error", message: err instanceof Error ? err.message : String(err), ...(msg.reqId ? { reqId: msg.reqId } : {}) });
        }
        return;
      }
      case "session.attach": {
        const session = this.sessions.get(msg.sessionId);
        if (!session) {
          this.reply({ type: "error", message: `unknown session: ${msg.sessionId}` });
          return;
        }
        this.subscribe(session.id);
        for (const event of this.interactions?.pendingEvents(session.id) ?? []) this.reply({ type: "event", event }); // rehydrate any open card for this session
        return;
      }
      case "session.send": {
        const session = this.sessions.get(msg.sessionId);
        if (!session) {
          // error+reqId so a request()-style client (desktop) can roll back its optimistic bubble instead of it hanging silently.
          this.reply({ type: "error", message: `unknown session: ${msg.sessionId}`, ...(msg.reqId ? { reqId: msg.reqId } : {}) });
          return;
        }
        this.subscribe(session.id);
        // Per-UI-session model/effort/permissionMode overrides (if present). Otherwise the global defaults (Slack also uses this path).
        // A runTurn throw is caught by the outer try/catch and replied as error+reqId.
        await session.master.runTurn(msg.text, { model: msg.model, effort: msg.effort, permissionMode: msg.permissionMode, clientMsgId: msg.clientMsgId });
        // Ack when a reqId is present so request()-style clients get a settled promise; fire-and-forget (no reqId) stays unchanged for old clients.
        if (msg.reqId) this.reply({ type: "fleet.ack", reqId: msg.reqId, action: "send", id: msg.sessionId });
        return;
      }
      case "session.stop": {
        // Interrupt the in-progress master turn. No-op if no turn is in progress. (ack even on failure)
        await this.sessions.stop(msg.sessionId);
        if (msg.reqId) this.reply({ type: "fleet.ack", reqId: msg.reqId, action: "stop", id: msg.sessionId });
        return;
      }
      case "interaction.respond": {
        // Approval/AskUserQuestion card response → resolves the pending canUseTool. The interaction.resolved event handles UI updates (no separate ack needed).
        this.interactions?.respond(msg.requestId, { decision: msg.decision, answers: msg.answers });
        return;
      }
      case "session.rename": {
        this.sessions.rename(msg.sessionId, msg.label); // setSessionLabel + session.label event
        this.reply({ type: "fleet.ack", reqId: msg.reqId, action: "rename", id: msg.sessionId });
        return;
      }
      case "session.archive": {
        this.sessions.archive(msg.sessionId, msg.archived);
        this.reply({ type: "fleet.ack", reqId: msg.reqId, action: "archive", id: msg.sessionId });
        return;
      }
      case "session.pin": {
        this.sessions.setPinned(msg.sessionId, msg.pinned);
        this.reply({ type: "fleet.ack", reqId: msg.reqId, action: "pin", id: msg.sessionId });
        return;
      }
      case "session.delete": {
        await this.sessions.delete(msg.sessionId);
        this.reply({ type: "fleet.ack", reqId: msg.reqId, action: "delete", id: msg.sessionId });
        return;
      }
      case "worker.rename": {
        this.repos.setWorkerLabel(msg.id, msg.label);
        this.bus.emit({ type: "worker.label", sessionId: "", workerId: msg.id, label: msg.label }); // live-update the UI fleet row
        this.reply({ type: "fleet.ack", reqId: msg.reqId, action: "rename", id: msg.id });
        return;
      }
      case "worker.archive": {
        this.fleet.archive(msg.id, msg.archived);
        this.reply({ type: "fleet.ack", reqId: msg.reqId, action: "archive", id: msg.id });
        return;
      }
      case "worker.delete": {
        await this.fleet.delete(msg.id); // discard(worktree) + remove DB row
        this.reply({ type: "fleet.ack", reqId: msg.reqId, action: "delete", id: msg.id });
        return;
      }
      case "session.list": {
        this.reply({ type: "session.list.result", sessions: this.sessions.list(), ...(msg.reqId ? { reqId: msg.reqId } : {}) });
        return;
      }
      case "worker.list": {
        const session = this.sessions.get(msg.sessionId);
        if (!session) {
          this.reply({ type: "error", message: `unknown session: ${msg.sessionId}` });
          return;
        }
        this.reply({
          type: "worker.list.result",
          sessionId: msg.sessionId,
          workers: this.fleet.list(),
          ...(msg.reqId ? { reqId: msg.reqId } : {}),
        });
        return;
      }
      case "fleet.list": {
        this.reply({ type: "fleet.list.result", reqId: msg.reqId, fleet: this.fleet.list() });
        return;
      }
      case "fleet.diff": {
        try {
          const diff = await this.fleet.diff(msg.id);
          this.reply({ type: "fleet.diff.result", reqId: msg.reqId, id: msg.id, diff });
        } catch (err) {
          this.reply({ type: "error", message: `fleet.diff: ${String(err)}`, reqId: msg.reqId });
        }
        return;
      }
      case "fleet.stop": {
        try { await this.fleet.stop(msg.id); } catch (err) { this.reply({ type: "error", message: String(err), reqId: msg.reqId }); return; }
        this.reply({ type: "fleet.ack", reqId: msg.reqId, action: "stop", id: msg.id });
        return;
      }
      case "fleet.discard": {
        try { await this.fleet.discard(msg.id); } catch (err) { this.reply({ type: "error", message: String(err), reqId: msg.reqId }); return; }
        this.reply({ type: "fleet.ack", reqId: msg.reqId, action: "discard", id: msg.id });
        return;
      }
      case "fleet.subscribe": {
        this.subscribe(FLEET_CHANNEL);
        return;
      }
      case "events.subscribe": {
        this.subscribe(ALL_CHANNEL);
        if (this.slack) {
          this.reply({ type: "event", event: { type: "slack.status", sessionId: ALL_CHANNEL, status: this.slack.status() } });
        }
        for (const event of this.interactions?.pendingEvents() ?? []) this.reply({ type: "event", event }); // rehydrate any open interaction cards (survives full reload)
        return;
      }
      case "slack.set": {
        if (!this.slack) return; // slack not injected (test path) — no-op (avoids replying with status:undefined)
        await this.slack.setEnabled(msg.enabled);
        this.reply({ type: "slack.ack", reqId: msg.reqId, status: this.slack.status() });
        return;
      }
      case "repos.list": {
        this.reply({ type: "repos.list.result", reqId: msg.reqId, repos: this.repos.listRepos().map((r) => ({ name: r.name, path: r.path, description: r.description, base: r.base })) });
        return;
      }
      case "repo.branches": {
        const repo = this.repos.getRepoByName(msg.repo);
        const branches = repo && this.source ? await this.source.listBranches(repo.path) : [];
        this.reply({ type: "repo.branches.result", reqId: msg.reqId, branches });
        return;
      }
      case "source.fetch": {
        const item = this.source ? await this.source.fetchSource(msg.url) : null;
        this.reply({ type: "source.fetch.result", reqId: msg.reqId, item });
        return;
      }
      case "source.search": {
        if (!this.source) return this.reply({ type: "source.search.result", reqId: msg.reqId, items: [] });
        let repoPath: string | undefined;
        if (msg.provider === "github") {
          const repo = msg.repo ? this.repos.getRepoByName(msg.repo) : undefined;
          if (!repo) return this.reply({ type: "source.search.result", reqId: msg.reqId, items: [] });
          repoPath = repo.path;
        }
        const items = await this.source.searchSource(msg.provider, msg.query, repoPath);
        this.reply({ type: "source.search.result", reqId: msg.reqId, items });
        return;
      }
      case "integrations.status": {
        const status: IntegrationsStatus = this.source
          ? await this.source.integrationsStatus()
          : { github: { available: false }, linear: { configured: false } };
        this.reply({ type: "integrations.status.result", reqId: msg.reqId, ...status });
        return;
      }
      case "auth.status": {
        // Active Claude auth (api key vs subscription OAuth) — env + the SDK's own token reader (file/Keychain).
        const reader = defaultTokenReader();
        const status = await getAuthStatus(process.env, () => reader.read());
        this.reply({ type: "auth.status.result", reqId: msg.reqId, ...status });
        return;
      }
      case "repos.register": {
        // base is passed positionally to git, so validate it against the ref whitelist just like MCP register_repo (defense-in-depth against arg injection).
        // (Path existence/.git validation is the MCP tool's job — over WS a token-authenticated local client sends a real path via the picker.)
        if (msg.base !== undefined && !isSafeGitRef(msg.base)) {
          this.reply({ type: "error", message: `repos.register: invalid base ref '${msg.base}' (no '..', spaces, or leading '-')`, reqId: msg.reqId });
          return;
        }
        this.repos.createRepo({ id: randomUUID(), name: msg.name, path: msg.path, description: msg.description, base: msg.base });
        this.reply({ type: "repos.ack", reqId: msg.reqId, action: "register", name: msg.name });
        return;
      }
      case "repos.update": {
        this.repos.updateRepo(msg.name, { description: msg.description, base: msg.base });
        this.reply({ type: "repos.ack", reqId: msg.reqId, action: "update", name: msg.name });
        return;
      }
      case "repos.remove": {
        this.repos.removeRepo(msg.name);
        this.reply({ type: "repos.ack", reqId: msg.reqId, action: "remove", name: msg.name });
        return;
      }
      case "session.history": {
        const rows = this.repos.listSessionEvents(msg.sessionId);
        const events: Array<{ seq: number; type: string; payload: unknown; createdAt: string }> = [];
        let skipped = 0;
        for (const r of rows) {
          try { events.push({ seq: r.seq, type: r.type, payload: JSON.parse(r.payload_json) as unknown, createdAt: r.created_at }); }
          catch { skipped++; console.warn(`[session.history] skip corrupt event seq=${r.seq} session=${msg.sessionId}`); }
        }
        if (skipped > 0) events.push({ seq: -1, type: "master.notice", payload: { type: "master.notice", sessionId: msg.sessionId, text: `${skipped} event(s) could not be loaded` }, createdAt: rows.at(-1)?.created_at ?? new Date(0).toISOString() });
        this.reply({ type: "session.history.result", reqId: msg.reqId, sessionId: msg.sessionId, events });
        return;
      }
      case "worker.history": {
        this.reply({ type: "worker.history.result", reqId: msg.reqId, id: msg.id, events: this.fleet.transcript(msg.id) });
        return;
      }
      case "worker.fork": {
        // Fork a worker → a new worker carrying the source's SDK context + full worktree state + transcript. Replies like fleet.spawn so the client navigates to it.
        try {
          const { id } = await this.fleet.fork(msg.id);
          this.reply({ type: "fleet.spawn.result", reqId: msg.reqId, id });
        } catch (err) {
          this.reply({ type: "error", message: err instanceof Error ? err.message : String(err), reqId: msg.reqId });
        }
        return;
      }
      case "worker.send": {
        // Deliver a follow-up message to a running worker (streaming input). Throws if the agent is terminated/unknown
        // or mid-restore, and the outer try/catch responds with error+reqId. On success, ack when a reqId is present so
        // request()-style clients (desktop) get a settled promise instead of a silently-dropped frame.
        this.fleet.send(msg.id, msg.text, msg.clientMsgId);
        if (msg.reqId) this.reply({ type: "fleet.ack", reqId: msg.reqId, action: "send", id: msg.id });
        return;
      }
      case "worker.setModel": {
        // Live-change a running worker's model. On failure the global catch responds with error+reqId. On success, ack when a
        // reqId is present so request()-style clients (desktop) settle — otherwise the promise dangles and a later socket close
        // rejects it, triggering a false optimistic rollback + toast.
        await this.fleet.setModel(msg.id, msg.model);
        if (msg.reqId) this.reply({ type: "fleet.ack", reqId: msg.reqId, action: "setModel", id: msg.id });
        return;
      }
      case "worker.setPermissionMode": {
        // Live-change a running worker's permission mode (bypassPermissions/plan). On failure the global catch responds with
        // error+reqId. On success, ack when a reqId is present (see worker.setModel — avoids a dangling promise a later close rejects).
        await this.fleet.setPermissionMode(msg.id, msg.permissionMode);
        if (msg.reqId) this.reply({ type: "fleet.ack", reqId: msg.reqId, action: "setPermissionMode", id: msg.id });
        return;
      }
      case "worker.interrupt": {
        // Interrupt the worker's current turn (session preserved). Throws if the agent is terminated/unknown → the global catch responds with error+reqId.
        await this.fleet.interrupt(msg.id);
        if (msg.reqId) this.reply({ type: "fleet.ack", reqId: msg.reqId, action: "interrupt", id: msg.id });
        return;
      }
      case "worker.checkpoints": {
        const checkpoints = this.repos.listCheckpoints(msg.id).map((c) => ({ seq: c.seq, sha: c.sha, createdAt: c.created_at }));
        this.reply({ type: "worker.checkpoints.result", reqId: msg.reqId, id: msg.id, checkpoints });
        return;
      }
      case "worker.restore": {
        await this.fleet.restore(msg.id, msg.seq);
        this.reply({ type: "fleet.ack", reqId: msg.reqId, action: "restore", id: msg.id });
        return;
      }
      case "commands.list": {
        // If there's an active worker, use its live session (including runtime-discovered skills); otherwise probe by cwd (cached).
        let commands: SlashCommandInfo[] = [];
        if (msg.workerId) commands = await this.fleet.listCommands(msg.workerId);
        if (commands.length === 0) {
          // cwd unspecified + not a worker (new session, no repo selected) → fall back to the daemon's default cwd. Since session.create
          // builds the session with process.cwd() when cwd is absent, show the same skills that session will actually have in the / autocomplete.
          const cwd = msg.cwd ?? (msg.workerId ? this.repos.getWorker(msg.workerId)?.worktree_path ?? undefined : (this.settings?.all().defaultSessionCwd?.trim() || process.cwd()));
          if (cwd && this.commands) commands = await this.commands.forCwd(cwd);
        }
        this.reply({ type: "commands.result", reqId: msg.reqId, commands });
        return;
      }
      case "usage.get": {
        this.reply({ type: "usage.result", reqId: msg.reqId, usage: this.usage?.snapshot() ?? emptyUsage() });
        return;
      }
      case "models.list": {
        // Live list (when a provider is injected) or static fallback — so the UI model picker is never empty.
        const models = (await this.models?.list()) ?? STATIC_MODELS;
        this.reply({ type: "models.result", reqId: msg.reqId, models });
        return;
      }
      case "settings.get": {
        if (!this.settings) return this.reply({ type: "error", message: "settings unavailable", reqId: msg.reqId });
        this.reply({ type: "settings.result", reqId: msg.reqId, settings: this.settings.all() });
        return;
      }
      case "settings.set": {
        if (!this.settings) return this.reply({ type: "error", message: "settings unavailable", reqId: msg.reqId });
        // Secrets (linear/anthropic/slack tokens) are handled separately, outside SettingsValues, so they aren't echoed. null/empty string → delete the key.
        const { linearApiKey, anthropicApiKey, slackBotToken, slackAppToken, ...rest } = msg.settings;
        if (linearApiKey !== undefined) this.settings.setLinearApiKey(linearApiKey?.trim() || undefined);
        if (anthropicApiKey !== undefined) {
          this.settings.setAnthropicApiKey(anthropicApiKey?.trim() || undefined);
          applyApiKeyToEnv(this.settings); // update process.env live so the SDK/models-provider pick up the new key without a restart
        }
        let slackTokenChanged = false;
        if (slackBotToken !== undefined) { this.settings.setSlackBotToken(slackBotToken?.trim() || undefined); slackTokenChanged = true; }
        if (slackAppToken !== undefined) { this.settings.setSlackAppToken(slackAppToken?.trim() || undefined); slackTokenChanged = true; }
        const result = this.settings.apply(rest);
        // If a token changed, re-evaluate Slack to (re)connect/stop (applied immediately on save). Best-effort.
        if (slackTokenChanged) void this.slack?.reconcile();
        this.reply({ type: "settings.result", reqId: msg.reqId, settings: result });
        return;
      }
      case "fleet.spawn": {
        const repo = this.repos.getRepoByName(msg.repo);
        if (!repo) {
          this.reply({ type: "error", message: `unknown repo '${msg.repo}'`, reqId: msg.reqId });
          return;
        }
        // base is passed positionally to git, so validate it against the ref whitelist just like MCP spawn_worker
        // (--end-of-options blocks option injection, but '..' ranges/spaces/leading-'-' are filtered out here).
        const spawnBase = msg.base ?? repo.base ?? undefined;
        if (spawnBase !== undefined && !isSafeGitRef(spawnBase)) {
          this.reply({ type: "error", message: `fleet.spawn: invalid base ref '${spawnBase}' (no '..', spaces, or leading '-')`, reqId: msg.reqId });
          return;
        }
        // Direct UI spawn uses a dedicated container session as its home (events also flow via @fleet).
        const home = this.sessions.getOrCreateByKey(UI_FLEET_SESSION_KEY, repo.path);
        const label = msg.label?.trim() || msg.task?.trim().slice(0, 40) || "worker";
        try {
          const { id } = await this.fleet.spawn({ homeSessionId: home.id, repoPath: repo.path, label, task: msg.task, base: spawnBase, model: msg.model, effort: msg.effort, permissionMode: msg.permissionMode, ticketKey: msg.ticketKey, ticketUrl: msg.ticketUrl });
          this.reply({ type: "fleet.spawn.result", reqId: msg.reqId, id });
        } catch (err) {
          this.reply({ type: "error", message: `fleet.spawn: ${String(err)}`, reqId: msg.reqId });
        }
        return;
      }
      case "automation.list": {
        if (!this.automations) return this.reply({ type: "error", message: "automations unavailable", reqId: msg.reqId });
        // 'once' (agent self-wakeup) automations are internal one-shot + auto-deleted → hide them from the UI automation list.
        const automations = this.automations.list().filter((a) => a.trigger.kind !== "once");
        this.reply({ type: "automation.list.result", reqId: msg.reqId, automations });
        return;
      }
      case "automation.create": {
        if (!this.automations) return this.reply({ type: "error", message: "automations unavailable", reqId: msg.reqId });
        const automation = this.automations.create(msg.automation as AutomationInput);
        this.bus.emit({ type: "automation.changed", sessionId: ALL_CHANNEL });
        this.reply({ type: "automation.result", reqId: msg.reqId, automation });
        return;
      }
      case "automation.update": {
        if (!this.automations) return this.reply({ type: "error", message: "automations unavailable", reqId: msg.reqId });
        const automation = this.automations.update(msg.id, msg.patch as AutomationInput);
        if (!automation) return this.reply({ type: "error", message: `unknown automation: ${msg.id}`, reqId: msg.reqId });
        this.bus.emit({ type: "automation.changed", sessionId: ALL_CHANNEL });
        this.reply({ type: "automation.result", reqId: msg.reqId, automation });
        return;
      }
      case "automation.set_enabled": {
        if (!this.automations) return this.reply({ type: "error", message: "automations unavailable", reqId: msg.reqId });
        const automation = this.automations.setEnabled(msg.id, msg.enabled);
        if (!automation) return this.reply({ type: "error", message: `unknown automation: ${msg.id}`, reqId: msg.reqId });
        this.bus.emit({ type: "automation.changed", sessionId: ALL_CHANNEL });
        this.reply({ type: "automation.result", reqId: msg.reqId, automation });
        return;
      }
      case "automation.delete": {
        if (!this.automations) return this.reply({ type: "error", message: "automations unavailable", reqId: msg.reqId });
        this.automations.delete(msg.id);
        this.bus.emit({ type: "automation.changed", sessionId: ALL_CHANNEL });
        this.reply({ type: "fleet.ack", reqId: msg.reqId, action: "delete", id: msg.id });
        return;
      }
      case "automation.run": {
        if (!this.automations) return this.reply({ type: "error", message: "automations unavailable", reqId: msg.reqId });
        await this.automations.runNow(msg.id, msg.vars ?? {});
        this.bus.emit({ type: "automation.changed", sessionId: ALL_CHANNEL });
        this.reply({ type: "fleet.ack", reqId: msg.reqId, action: "run", id: msg.id });
        return;
      }
    }
    } catch (err) {
      this.reply({ type: "error", message: String(err), reqId: (msg as { reqId?: string }).reqId });
    }
  }

  dispose(): void {
    for (const off of this.unsubs.values()) off();
    this.unsubs.clear();
  }
}
