import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import type { AddressInfo } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import type { RawData } from "ws";
import { query as sdkQuery, forkSession as sdkForkSession } from "@anthropic-ai/claude-agent-sdk";
import type { Config } from "../config.js";
import { openDb } from "../persistence/db.js";
import { Repositories } from "../persistence/repositories.js";
import { EventBus } from "../core/events.js";
import { SessionManager } from "../core/session-manager.js";
import type { QueryFn } from "../core/claude-backend.js";
import { RealGitOps } from "../core/git-ops.js";
import { ClaudeBackend } from "../core/claude-backend.js";
import { CodexBackend } from "../core/codex/codex-backend.js";
import { realCodexSpawn } from "../core/codex/codex-transport.js";
import type { Locale } from "../core/i18n.js";
import { FleetOrchestrator } from "../core/fleet-orchestrator.js";
import type { WorkerLike } from "../core/fleet-orchestrator.js";
import { Worker } from "../core/worker.js";
import { makeLabeler } from "../core/labeler.js";
import { CommandCatalog } from "../core/commands.js";
import { fetchGitHubItem, searchGitHubItems, githubAuthStatus } from "../core/source-intake.js";
import type { SourceProviderId } from "../core/source-intake.js";
import { RealLinearClient } from "../core/linear-client.js";
import { UsageCollector } from "../core/usage.js";
import { makeOAuthUsageProvider } from "../core/oauth-usage.js";
import { makeModelsProvider } from "../core/models-provider.js";
import { makeCodexModelsProvider } from "../core/codex-models-provider.js";
import { Settings, applyApiKeyToEnv } from "../core/settings.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { Connection } from "./connection.js";
import { McpBridge } from "./mcp-bridge.js";
import { materializeCodexHome, removeCodexHome, seedCodexHomeFromSource, gcOrphanCodexHomes } from "./codex-home.js";
import { acquireSingleInstance } from "./lifecycle.js";
import { loadOrCreateToken, checkUpgradeAuth, tokenMatches } from "./auth.js";
import { secureHome } from "./fs-hardening.js";
import { startSlack } from "../slack/app.js";
import { SlackInteractionBridge, makeSlackCanUseTool, parseSlackThreadKey } from "../slack/interaction.js";
import { makeSlackCapabilities } from "../slack/capabilities.js";
import { makeHolder } from "../slack/holder.js";
import type { SlackThreadReader } from "../tools/slack-thread-tools.js";
import type { SlackRefResolver } from "../slack/name-resolver.js";
import { InteractionRegistry } from "../core/interaction-registry.js";
import { scheduleToolDefs, SCHEDULE_SERVER_NAME, SCHEDULE_TOOL_NAMES } from "../tools/schedule-tools.js";
import type { SlackHandle } from "../slack/app.js";
import { SlackController } from "../slack/controller.js";
import { DEFAULT_USAGE_REFRESH_MS } from "../core/settings.js";
import { ALL_CHANNEL } from "../core/events.js";
import { Scheduler } from "../core/scheduler.js";
import { WorkerNotifier } from "../core/worker-notifier.js";
import { AutomationDispatcher } from "../core/automation-dispatcher.js";
import { makeSlackTriggerHandler } from "../slack/trigger-source.js";
import type { AutomationProvider } from "./connection.js";
import type { AutomationInput } from "../persistence/repositories.js";

export interface DaemonHandle {
  port: number;
  token: string;
  close(): Promise<void>;
}

export interface StartDaemonOptions {
  config: Config;
  queryFn?: QueryFn;
  acquireLock?: boolean;
  heartbeatMs?: number; // WS ping/pong interval (default 30s). For detecting/cleaning up half-open sockets.
  onShutdownRequest?: () => void; // invoked on an authenticated POST /shutdown (the desktop's graceful-stop path, esp. Windows where SIGTERM hard-kills)
}

export async function startDaemon(opts: StartDaemonOptions): Promise<DaemonHandle> {
  const { config } = opts;
  const queryFn: QueryFn = opts.queryFn ?? sdkQuery;
  // Provider-neutral backend over the injected queryFn (P0 seam). CommandCatalog/makeLabeler stay on the raw
  // queryFn deliberately — Claude-specific aux paths, gated per provider in P1.
  const backend = new ClaudeBackend(queryFn);
  // Non-loopback binds send the token in plaintext over ws:// → fail-closed reject unless explicitly opted in (G-ORIGIN-AUTH).
  // Check before touching lock/DB so we fail fast without side effects.
  const isLoopback = ["127.0.0.1", "::1", "localhost"].includes(config.host);
  const allowNonLoopback = ["1", "true", "yes"].includes((process.env.ROOKERY_ALLOW_NONLOOPBACK ?? "").trim().toLowerCase());
  if (!isLoopback && !allowNonLoopback) {
    throw new Error(
      `refusing to bind non-loopback host '${config.host}': the WS token would travel in plaintext over ws://. ` +
        `Set ROOKERY_ALLOW_NONLOOPBACK=1 to override (and prefer a trusted tunnel / wss).`,
    );
  }
  if (!isLoopback) {
    process.stderr.write(
      `[rookery] WARNING: binding non-loopback host ${config.host} (ROOKERY_ALLOW_NONLOOPBACK set) — the WS token ` +
        `travels in plaintext over ws://. Expose only behind a trusted tunnel. The MCP bridge (a codex master ` +
        `turn's per-turn tool endpoint, P2.5 Track A) is also reachable on this bind — anyone holding a live ` +
        `session's bridge URL/token can call rookery's in-process tools.\n`,
    );
  }
  secureHome(config); // tighten ~/.rookery to 0700 + sensitive files to 0600 (boot repair). best-effort, never throws.
  const lock = opts.acquireLock === false ? null : acquireSingleInstance(config.pidPath);
  const token = loadOrCreateToken(config.tokenPath); // per-daemon secret for WS authentication

  let db;
  try {
    db = openDb(config.dbPath);
  } catch (err) {
    process.stderr.write(`[rookery] DB open failed: ${String(err)}\n`);
    process.exit(1);
  }
  const repos = new Repositories(db);
  const bus = new EventBus();
  const git = new RealGitOps();
  const settings = new Settings(repos, config);
  applyApiKeyToEnv(settings); // inject the in-app (DB-first, env-fallback) Anthropic key into process.env so the SDK subprocess/models-provider/auth-status pick it up
  // Daemon-hosted MCP bridge (P2 — docs/2026-07-06-p2-codex-master.md): mounted on THIS http server (see
  // below, before existing routing) so a codex master turn's per-turn ephemeral child can reach rookery's
  // in-process tool servers (memory/repos/fleet/schedule) the way the Claude Agent SDK reaches them in-process.
  const bridge = new McpBridge({});
  // Actual bound port for bridge URLs: config.port may be 0 (OS-assigned ephemeral, common in tests) — the
  // bridge closure below reads this var (not config.port) so it resolves the REAL listening port, updated
  // once listen() resolves further down. Before that (there is no turn that early), it's config.port itself.
  let boundPort = config.port;
  // Backend registry (P1): workers pick by provider; the master stays on Claude.
  // Codex auth = the user's ~/.codex/auth.json (`codex login`) by default — see codex-transport.ts AUTH NOTE.
  // P1.5: an in-app codexApiKey (settings) redirects the child to a rookery-managed CODEX_HOME and
  // provisions auth.json via RPC (see codex-backend.ts pump()), leaving the user's ~/.codex untouched.
  const codexHomeDir = path.join(config.home, "codex-home");
  const codexBackend = new CodexBackend({
    spawn: realCodexSpawn(() => settings.codexBin()),
    defaultModel: () => settings.codexWorkerModel(),
    apiKey: () => settings.codexApiKey(),
    // Per-turn inactivity watchdog (P2.5 Track B — docs/2026-07-06-p25-codex-hardening.md): resolved
    // fresh every turn, same as the other settings resolvers on this backend. 0/negative disables it
    // (see Settings.codexTurnIdleTimeoutMs's own comment for the fail-safe parse).
    idleTimeoutMs: () => settings.codexTurnIdleTimeoutMs(),
    // Pre-turn handshake+thread-start timeout (P3-remaining Track A — docs/2026-07-06-p3r-codex-hardening-finish.md):
    // resolved fresh per stream, same convention as idleTimeoutMs above. Covers openClient()+
    // startOrResumeThread(), a phase the idle watchdog above does NOT cover (it only arms after
    // turn/start's response).
    handshakeTimeoutMs: () => settings.codexHandshakeTimeoutMs(),
    env: () => {
      if (!settings.codexApiKey()) return undefined;
      fs.mkdirSync(codexHomeDir, { recursive: true });
      return { CODEX_HOME: codexHomeDir };
    },
    // P2.5 Track A (docs/2026-07-06-p25-codex-hardening.md): the closure materializes the per-session
    // CODEX_HOME (config.toml with the bridge url + auth.json passthrough, see codex-home.ts) and hands
    // the backend back just the directory path — core must not import daemon code, see codex-backend.ts's
    // comment on `bridge`. The bridge URL itself never leaves this closure (no argv, no env either).
    bridge: {
      ensureSession: (key, defs) => {
        const { url } = bridge.ensureSession(key, defs);
        const codexHome = materializeCodexHome(config.home, key, url(config.host, boundPort), {
          apiKeySet: !!settings.codexApiKey(),
          realCodexHome: process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
        });
        return { codexHome };
      },
    },
  });
  // Item 6 (docs/2026-07-06-p25-codex-hardening.md): the ONE place both a session's MCP bridge
  // registration AND its materialized per-session CODEX_HOME dir are torn down together, so a future
  // second delete caller can't release one half and leak the other. P3-remaining Track B #3
  // (docs/2026-07-06-p3r-codex-hardening-finish.md): wired into SessionManager.delete via deps
  // (SessionManagerDeps.onSessionDelete) — the single owner, since that's the ONE delete path every
  // caller (Connection, and any future programmatic caller) goes through. Both steps are best-effort/
  // never-throw individually (bridge.release no-ops on an unknown key; removeCodexHome swallows fs
  // errors), so this closure itself never throws either.
  const onSessionDelete = (id: string): void => {
    bridge.release(id);
    removeCodexHome(config.home, id);
  };
  const workerBackends: Record<string, import("../core/agent-backend.js").AgentBackend> = { claude: backend, codex: codexBackend };
  const subFactory = (o: { id: string; sessionId: string; repoPath: string; label: string; sdkSessionId?: string | null; model?: string; effort?: string; permissionMode?: string; onTurnStart?: () => void; maxTurns?: number; costBudgetUsd?: number; provider?: string }): WorkerLike =>
    new Worker({
      id: o.id,
      sessionId: o.sessionId,
      repoPath: o.repoPath,
      label: o.label,
      // spawn override (UI) takes priority, otherwise fall back to the global default (Slack/master spawn).
      // permissionMode: absent → the Worker defaults to "bypassPermissions". backend/model are picked by provider (default claude).
      deps: {
        repos, bus,
        backend: workerBackends[o.provider ?? "claude"] ?? backend,
        model: o.model ?? (o.provider === "codex" ? settings.codexWorkerModel() : settings.workerModel()),
        effort: o.effort ?? settings.workerEffort(),
        permissionMode: o.permissionMode, onTurnStart: o.onTurnStart, maxTurns: o.maxTurns,
        // explicit spawn override wins; else the settings default; else unlimited (null/0/negative/malformed → null via the getter).
        costBudgetUsd: o.costBudgetUsd ?? settings.workerCostBudgetUsd() ?? undefined,
      },
      sdkSessionId: o.sdkSessionId ?? null,
    });
  // Auto-generate labels (Haiku): workers right after spawn, masters from the first message. best-effort.
  const summarizeLabel = makeLabeler(queryFn);
  const fleet = new FleetOrchestrator({
    repos, bus, git, factory: subFactory, worktreesDir: config.fleet.worktreesDir, summarizeLabel,
    // Fork routing by provider: codex forks via an ephemeral app-server child (CodexBackend.forkSession); claude keeps the SDK's own forkSession.
    forkSession: (provider, id, opts) => (provider === "codex" ? codexBackend.forkSession(id) : sdkForkSession(id, opts)),
  });
  // Restart recovery: restore the previous process's workers from the DB as detached entries (diff/discard/stop still work) +
  // clean up running/idle zombies to orphaned. (Live conversations can't be revived — the SDK session dies with the process.)
  fleet.rehydrate();
  // Also clean up master session zombies: sessions stuck in 'running' by a hard crash get reset to idle (sessions are lazy, so there's no live turn at boot → prevents a stale pulse on reconnect).
  repos.resetRunningSessions();
  // Likewise clear automation rows left 'running' by a mid-run crash → otherwise the Automation page shows a perpetual pulse.
  repos.resetRunningAutomations();
  // P3-remaining Track B #7 (docs/2026-07-06-p3r-codex-hardening-finish.md): sweep orphaned per-session
  // CODEX_HOME dirs (no backing session row — left behind by a crash mid-delete or mid-fork). Boot-only:
  // no in-flight fork/create can race it this early (before any WS connection is accepted).
  gcOrphanCodexHomes(config.home, new Set(repos.listSessions().map((s) => s.id)));
  // Slack holders (bridge / thread reader / reporter-ensure) — installed by startSlack on connect, released
  // owner-scoped on stop (clearIf) so a stale connection's late stop can't clobber the live one's holders.
  const bridgeHolder = makeHolder<SlackInteractionBridge>();
  const threadReaderHolder = makeHolder<SlackThreadReader>();
  const reporterHolder = makeHolder<(sessionId: string, externalKey: string) => void>();
  const nameResolverHolder = makeHolder<SlackRefResolver>();
  // For non-Slack (desktop/UI) sessions, canUseTool routes through a registry that surfaces it via EventBus→WS (Connection handles the respond).
  const interactionRegistry = new InteractionRegistry(bus);
  // P3 Track A (docs/2026-07-06-p3-codex-fork-automation.md): forks a codex MASTER session. Unlike
  // fleet's codex fork (workers share one CODEX_HOME, so a plain forkSession(threadId) suffices),
  // a codex master's rollouts live in a per-session CODEX_HOME — the fork child must run there
  // (thread/fork looks up threadId in the CWD it's spawned with), and the NEW session's home must be
  // pre-seeded with the source's sessions/ tree (parent + forked rollout) so context survives (the
  // forked rollout is a delta referencing the parent — see codex-home.ts seedCodexHomeFromSource).
  // Only reachable via SessionManager's forkSession router below — the fleet/worker one is unchanged.
  const forkCodexMaster = async (sourceThreadId: string, opts?: { sourceSessionId?: string; newSessionId?: string }): Promise<{ sessionId: string }> => {
    const sourceSessionId = opts?.sourceSessionId;
    const newSessionId = opts?.newSessionId;
    if (!sourceSessionId || !newSessionId) throw new Error("cannot fork codex session: missing sourceSessionId/newSessionId");
    const sourceHome = path.join(config.home, "codex-homes", sourceSessionId);
    if (!fs.existsSync(sourceHome)) throw new Error("cannot fork codex session: source CODEX_HOME missing (run a turn first)");
    const { sessionId: forkedUuid } = await codexBackend.forkSession(sourceThreadId, { env: { ...process.env, CODEX_HOME: sourceHome } });
    seedCodexHomeFromSource(config.home, sourceSessionId, newSessionId);
    return { sessionId: forkedUuid };
  };
  const sessions = new SessionManager({ repos, bus, backends: { claude: backend, codex: codexBackend }, masterModel: () => settings.masterModel(), masterModelByProvider: { codex: () => settings.codexMasterModel() }, masterEffort: () => settings.masterEffort(), masterName: () => settings.masterName(), fleet, summarizeLabel, onSessionDelete,
    // Fork routing by provider: codex routes through forkCodexMaster (per-session CODEX_HOME
    // relocation, see above); claude keeps the SDK's own (eager) forkSession.
    forkSession: (provider, id, opts) => (provider === "codex" ? forkCodexMaster(id, opts) : sdkForkSession(id, opts)),
    makeCanUseTool: (externalKey, sessionId) => makeSlackCanUseTool(externalKey, () => bridgeHolder.get()) ?? interactionRegistry.canUseToolFor(sessionId),
    // Source-scoped dynamic capabilities: schedule_* tools for every master session (self-wakeup, backed by the daemon Scheduler) +
    // additionally compose the read_thread tool/hint into slack thread sessions.
    // Schedule travels the toolDefs channel (not mcpServers): codex ignores opts.mcpServers (it has no
    // in-process MCP concept — see agent-backend.ts), so an opaque SDK server here would silently never
    // reach a codex master. toolDefs is the provider-neutral twin — master-agent.ts's doTurn merges it
    // into the same defs record the base memory/repos/fleet groups travel on, which the Claude adapter
    // wraps with createSdkMcpServer (same factory chain, same version "0.0.1", byte-equivalent server)
    // and the Codex adapter flattens onto the daemon MCP bridge, so codex masters now get schedule_* too.
    makeCapabilities: (externalKey, sessionId) => {
      const slackCaps = makeSlackCapabilities(externalKey, () => threadReaderHolder.get());
      return () => {
        const s = slackCaps?.() ?? {};
        return {
          ...s,
          toolDefs: { ...s.toolDefs, [SCHEDULE_SERVER_NAME]: scheduleToolDefs({ repos, reconcile: (id) => scheduler.reconcile(id), now: () => new Date() }, sessionId) },
          allowedTools: [...(s.allowedTools ?? []), ...SCHEDULE_TOOL_NAMES],
        };
      };
    } });
  // Worker completion → wake the home master (notify mode). deliver routes to the live master or persists for a cold one.
  const notifier = new WorkerNotifier({ bus, repos, deliver: (sessionId, n) => sessions.deliverWorkerNotification(sessionId, n) });
  const stopNotifier = notifier.start();
  notifier.sweepSettled(); // arms stranded by the restart (rehydrate writes statuses with no bus events)
  // For slash-command/skill candidates — a one-time probe per cwd, cached (model is irrelevant, just init with a cheap model).
  const commandCatalog = new CommandCatalog(queryFn, { model: () => settings.workerModel() });
  // Spawn from sources: list of base branches + GitHub issues/PRs (gh) + Linear tickets (GraphQL) + integration status. All best-effort.
  // timeout+SIGKILL: keeps a stuck gh (network stall / non-tty auth prompt / proxy blackhole) from leaking the child and
  // hanging source.* requests forever (same guard as the usage collector).
  const execText = (cmd: string, args: string[], opts?: { cwd?: string }) =>
    promisify(execFile)(cmd, args, { cwd: opts?.cwd, maxBuffer: 8 * 1024 * 1024, timeout: 30000, killSignal: "SIGKILL" }).then((r) => r.stdout.toString());
  const linear = new RealLinearClient(() => settings.linearApiKey(), fetch);
  const sourceProvider = {
    listBranches: (repoPath: string) => git.listBranches(repoPath),
    fetchSource: (url: string) => fetchGitHubItem(url, execText),
    searchSource: (provider: SourceProviderId, query: string, repoPath?: string) =>
      provider === "linear" ? linear.searchIssues(query) : searchGitHubItems(repoPath ?? "", query, execText),
    integrationsStatus: async () => {
      const [github, lv] = await Promise.all([githubAuthStatus(execText), linear.validate()]);
      return { github, linear: { configured: !!settings.linearApiKey(), valid: lv.ok, user: lv.user } };
    },
  };

  // ccusage (bunx) based usage collector. Polled periodically and cached, served via usage.get.
  const pexec = promisify(execFile);
  const cmd = config.usage.ccusageCmd;
  // The refresh interval comes from settings (DB). Applied once at boot (changes take effect on daemon restart). Invalid values fall back to the default.
  const parsedRefresh = Number.parseInt(settings.usageRefreshMs(), 10);
  const usageRefreshMs = Number.isInteger(parsedRefresh) && parsedRefresh > 0 ? parsedRefresh : DEFAULT_USAGE_REFRESH_MS;
  const usageCollector = new UsageCollector({
    refreshMs: usageRefreshMs,
    exec: {
      run: async (args) => {
        // timeout+SIGKILL so a stuck bunx/ccusage can't freeze the collector forever.
        const { stdout } = await pexec(cmd[0]!, [...cmd.slice(1), ...args], { maxBuffer: 64 * 1024 * 1024, env: process.env, timeout: 30000, killSignal: "SIGKILL" });
        return stdout.toString();
      },
    },
    oauthUsage: makeOAuthUsageProvider(), // server-side % (queries /api/oauth/usage with the local OAuth token)
  });
  usageCollector.start();
  const usageProvider = { snapshot: () => usageCollector.snapshot() };
  // List of available models (for the settings picker): x-api-key if there's an API key, otherwise the Claude Code OAuth token (same token reader as usage). Static fallback on failure.
  const modelsList = makeModelsProvider({ apiKey: () => settings.anthropicApiKey() });
  const modelsProvider = { list: () => modelsList() };
  // Codex model/effort catalog (for the desktop Codex model picker): spawns a short-lived app-server
  // child and caches the first successful result for the daemon's lifetime (see codex-models-provider.ts).
  const codexModelsProvider = makeCodexModelsProvider({ spawn: realCodexSpawn(() => settings.codexBin()) });

  // Slack runtime config is resolved per call from settings (DB, tokens fall back to env). Tokens at connect time, the rest per message.
  const slackConfig = () => ({
    botToken: settings.slackBotToken(),
    appToken: settings.slackAppToken(),
    cwd: settings.slackCwd(),
    allowedUsers: settings.slackAllowedUsers().split(",").map((s) => s.trim()).filter(Boolean),
    allowAll: ["1", "true", "yes"].includes(settings.slackAllowAll().trim().toLowerCase()),
    refuseReply: ["1", "true", "yes"].includes(settings.slackRefuseReply().trim().toLowerCase()),
    refusalMessage: settings.slackRefusalMessage(),
    locale: settings.slackLocale() as Locale,
    workerRelayEnabled: settings.workerSlackRelayEnabled() === "1",
    workerRelayChannel: settings.workerSlackRelayChannel(),
    // P2.5 Track C: which AgentBackend newly-created slack-origin sessions run on ("claude"/"codex",
    // default "claude" — opt-in). A codex slack session is bypassPermissions-only (P2 guard); a
    // non-bypass slack permission config would fail the turn at start.
    provider: settings.slackProvider(),
  });
  // Slack Bolt starts asynchronously (doesn't block boot). Status is broadcast to @all via slack.status.
  const dispatcher = new AutomationDispatcher({
    repos, bus, sessions, fleet,
    // Just before firing: if the target is a slack-origin session, ensure its thread reporter (only when connected). Even headless turns (wakeup) are delivered to Slack.
    beforeRun: (a) => {
      const ensure = reporterHolder.get();
      if (a.action.kind !== "master" || !a.action.targetSessionId || !ensure) return;
      const row = repos.getSession(a.action.targetSessionId);
      if (row?.external_key) ensure(row.id, row.external_key);
    },
  });
  const scheduler = new Scheduler({ repos, dispatcher });
  const automationProvider: AutomationProvider = {
    list: () => repos.listAutomations(),
    create: (input: AutomationInput) => {
      const a = repos.createAutomation(randomUUID(), input);
      scheduler.reconcile(a.id);
      return repos.getAutomation(a.id)!;
    },
    update: (id: string, patch: AutomationInput) => {
      const a = repos.updateAutomation(id, patch);
      if (a) scheduler.reconcile(id);
      return repos.getAutomation(id);
    },
    delete: (id: string) => repos.deleteAutomation(id),
    setEnabled: (id: string, enabled: boolean) => {
      const a = repos.setAutomationEnabled(id, enabled);
      if (a) scheduler.reconcile(id);
      return repos.getAutomation(id);
    },
    runNow: (id, vars) => scheduler.runNow(id, vars), // forward vars as-is (the run-now dialog inputs) — dropping them substitutes {{var}} with an empty string
  };
  scheduler.start();
  const slackTrigger = makeSlackTriggerHandler({ repos, dispatcher });

  const slack = new SlackController({
    configured: () => settings.slackConfigured(), // resolver, since tokens can change at runtime
    enabled: () => repos.getSetting("slackEnabled") !== "0", // on by default
    setEnabled: (b) => repos.setSetting("slackEnabled", b ? "1" : "0"),
    start: () => startSlack({ sessions, bus, slackConfig, home: config.home,
      setBridge: (b) => { if (b) bridgeHolder.set(b); },
      clearBridge: (b) => bridgeHolder.clearIf(b),
      setThreadReader: (r) => { if (r) threadReaderHolder.set(r); },
      clearThreadReader: (r) => threadReaderHolder.clearIf(r),
      setReporterFor: (fn) => { if (fn) reporterHolder.set(fn); },
      clearReporterFor: (fn) => reporterHolder.clearIf(fn),
      setNameResolver: (r) => { if (r) nameResolverHolder.set(r); },
      clearNameResolver: (r) => nameResolverHolder.clearIf(r),
      resolveThread: (id) => parseSlackThreadKey(repos.getSession(id)?.external_key ?? null), onMessage: slackTrigger }),
    emit: (status) => bus.emit({ type: "slack.status", sessionId: ALL_CHANNEL, status }),
  });
  void slack.boot();
  // automation.resolveSlackRefs backing function (audit #51): no resolver (Slack unconfigured/off/disconnected) or any
  // lookup failure both degrade to empty maps — never rejects, never blocks automation.list (a separate request).
  const resolveSlackRefs = async (channels: string[], users: string[]) => {
    const resolver = nameResolverHolder.get();
    if (!resolver) return { channels: {}, users: {} };
    try { return await resolver.resolve(channels, users); } catch { return { channels: {}, users: {} }; }
  };

  const httpServer = http.createServer((req, res) => {
    // MCP bridge FIRST: a codex master turn's per-turn child reaches its tools at /mcp/<token> on this same
    // server. handleHttp returns false for anything outside its base path, so this falls through cleanly.
    if (bridge.handleHttp(req, res)) return;
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      return;
    }
    // Graceful shutdown trigger (token-authenticated). Lets the desktop stop the daemon cleanly on Windows, where
    // process.kill(pid,'SIGTERM') is a hard TerminateProcess() that skips the SIGTERM handler / daemon.close().
    if (req.method === "POST" && req.url === "/shutdown") {
      if (!tokenMatches(token, req.headers["x-rookery-token"] as string | undefined)) { res.writeHead(401).end(); return; }
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      opts.onShutdownRequest?.();
      return;
    }
    res.writeHead(404).end();
  });
  // ws-halfopen-4: timeout so an idle TCP socket that never sends headers/a request doesn't hang around forever.
  // (Half-open on an upgraded WS is handled by the heartbeat above.)
  httpServer.headersTimeout = 20000;
  httpServer.requestTimeout = 30000;

  const wss = new WebSocketServer({ noServer: true, clientTracking: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const reqPath = (req.url ?? "").split("?")[0];
    if (reqPath !== "/ws") {
      socket.destroy();
      return;
    }
    // Auth: token match + reject external web Origins. On failure, 401 then close the socket.
    if (!checkUpgradeAuth({ url: req.url, headers: { origin: req.headers.origin } }, token).ok) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  const MAX_BUFFERED = 8 * 1024 * 1024; // prevent unbounded buffering to slow/dead consumers (G-WS-LEAK backpressure)
  wss.on("connection", (ws: WebSocket) => {
    const live = ws as WebSocket & { isAlive?: boolean };
    live.isAlive = true;
    ws.on("pong", () => { live.isAlive = true; }); // client proves it's alive by responding to the ping
    const send = (d: string) => {
      if (ws.readyState !== WebSocket.OPEN) return; // don't send to closed/half-closed sockets
      if (ws.bufferedAmount > MAX_BUFFERED) { ws.terminate(); return; } // backpressure: cut it off to stop the leak
      ws.send(d);
    };
    const conn = new Connection({ send }, sessions, bus, fleet, repos, usageProvider, settings, commandCatalog, sourceProvider, slack, modelsProvider, interactionRegistry, automationProvider, resolveSlackRefs, codexModelsProvider);
    ws.on("message", (raw: RawData) => {
      void conn.handleRaw(raw.toString());
    });
    ws.on("close", () => conn.dispose());
    ws.on("error", () => conn.dispose());
  });

  // Heartbeat: detect half-open sockets via ping/pong and terminate them (G-WS-LEAK). terminate → 'close' →
  // conn.dispose() releases the EventBus subscription, preventing a permanent leak. unref so the timer doesn't keep the process alive.
  const heartbeatMs = opts.heartbeatMs ?? 30000;
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const live = ws as WebSocket & { isAlive?: boolean };
      if (live.isAlive === false) { ws.terminate(); continue; } // no pong to the previous ping → dead socket
      live.isAlive = false;
      try { ws.ping(); } catch { /* best-effort */ }
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  const close = async (): Promise<void> => {
    // Park worker-notify FIRST — before ANY other shutdown step. Parking has zero ordering dependencies, and a worker
    // that settles NATURALLY during a later await (slack.stop / socket teardown) would otherwise be consumed by a still-
    // subscribed notifier, launching a ghost master flush turn mid-shutdown (racing db.close; the failed re-persist then
    // loses the notification forever). fleet.close's stop() also synchronously emits worker.status 'stopped' for every
    // live worker. Parked, the arms stay notify_armed=1 in the DB and the next boot's sweepSettled() delivers them.
    stopNotifier();
    usageCollector.stop();
    scheduler.stop();
    clearInterval(heartbeat);
    // Destroy sockets immediately instead of a graceful close (ensures the close() Promise doesn't wait forever).
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    httpServer.closeAllConnections?.(); // Node 18.2+: forcibly close any remaining keep-alive connections
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    await slack.stop();
    // Finish in-flight writes before db.close() (G-SHUTDOWN-RACE): stop live workers + drain master turns.
    // Otherwise writing to a closed DB raises a 'database is not open' unhandled rejection.
    await fleet.close(5000);
    await sessions.drain(5000);
    db.close();
    lock?.release();
  };

  try {
    await new Promise<void>((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(config.port, config.host, () => {
        httpServer.removeListener("error", reject);
        resolve();
      });
    });
  } catch (err) {
    // Bind failed (EADDRINUSE etc.). Without this handler the 'error' event is swallowed by the process-level
    // uncaughtException guard and startDaemon never settles — a zombie holding the PID lock forever.
    // Tear down everything already started so the lock/DB are released, then surface the failure to the caller.
    await close().catch(() => {});
    throw err;
  }
  const port = (httpServer.address() as AddressInfo).port;
  boundPort = port; // resolve the codexBackend bridge closure to the REAL listening port (config.port may have been 0)

  return { port, token, close };
}
