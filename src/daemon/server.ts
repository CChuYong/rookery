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
import { makeCodexUsageProvider } from "../core/codex-usage-provider.js";
import { makeCodexAuthProvider } from "../core/codex-auth-provider.js";
import { makeCodexCapabilitiesProvider } from "../core/codex-capabilities-provider.js";
import { CapabilityService } from "../core/capabilities/service.js";
import { CapabilityRegistry } from "../core/capabilities/registry.js";
import { CapabilityResolver } from "../core/capabilities/resolver.js";
import { CapabilityRuntimeState } from "../core/capabilities/runtime-state.js";
import { CapabilityRuntime, gcCapabilityRuntime } from "./capability-runtime.js";
import { CapabilityRepoWatcher } from "./capability-repo-watcher.js";
import { GeneratedCapabilityPackStore } from "./generated-capability-pack-store.js";
import { Settings, applyApiKeyToEnv } from "../core/settings.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { Connection } from "./connection.js";
import { McpBridge } from "./mcp-bridge.js";
import { ExternalMcpController } from "./external-mcp-controller.js";
import { externalToolDefs } from "../tools/external-tools.js";
import {
  codexHomeDirFor,
  materializeCodexHome,
  removeCodexHome,
  removeCodexWorkerHome,
  seedCodexHomeFromSource,
  seedCodexWorkerHomeFromLegacy,
  seedCodexWorkerHomeFromSource,
  gcOrphanCodexHomes,
} from "./codex-home.js";
import { acquireSingleInstance } from "./lifecycle.js";
import { loadOrCreateToken, checkUpgradeAuth, tokenMatches } from "./auth.js";
import { secureHome } from "./fs-hardening.js";
import { startSlack } from "../slack/app.js";
import { SlackInteractionBridge, makeSlackCanUseTool, parseSlackThreadKey } from "../slack/interaction.js";
import { makeSlackCapabilities } from "../slack/capabilities.js";
import { makeHolder } from "../slack/holder.js";
import type { SlackReadOps } from "../tools/slack-tools.js";
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
import { startWorkerTriggerSource } from "../core/worker-trigger-source.js";
import type { AutomationProvider } from "./connection.js";
import type { AutomationInput } from "../persistence/repositories.js";
import { SideConversationManager, type SideSource } from "../core/side-conversation.js";
import { realClaudeWorkflowFiles } from "./claude-workflow-files.js";
import { ClaudeWorkflowRegistry } from "./claude-workflow-registry.js";

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
  // Capability runtime composition precedes every agent factory. Registry/resolver projections remain
  // secret-free; the materializer is the sole reader of values and returns them only as a child env overlay.
  const capabilityRegistry = new CapabilityRegistry(repos, {
    onChanged: ({ generation, affected }) => {
      bus.emit({ type: "capabilities.changed", sessionId: ALL_CHANNEL, generation, affected });
    },
  });
  const generatedCapabilityPacks = new GeneratedCapabilityPackStore(path.join(config.home, "capability-packs"));
  const capabilityResolver = new CapabilityResolver(capabilityRegistry);
  const capabilityRuntimeState = new CapabilityRuntimeState(bus);
  const capabilityRuntime = new CapabilityRuntime(config.home, {
    getSecretValue: (packInstanceId, key) => capabilityRegistry.getSecretValueForRuntime(packInstanceId, key),
  });
  // Provider-neutral backend over the injected queryFn (P0 seam). CommandCatalog/makeLabeler stay on the raw
  // queryFn deliberately — Claude-specific aux paths, gated per provider in P1.
  const backend = new ClaudeBackend(queryFn, (capabilities) => capabilityRuntime.materializeClaude(capabilities));
  // Agent factories close over this target resolver. They are invoked only after composition finishes
  // (rehydrate creates detached metadata; lazy materialize happens on a later user action).
  let capabilityService!: CapabilityService;
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
  const realCodexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  // Shared codex auth resolvers — used by BOTH the turn children (CodexBackend below) and the model/list
  // catalog child (makeCodexModelsProvider) so the catalog authenticates under the SAME account the turns
  // run under (findings [25]/[26]). When an in-app codexApiKey is set the child is redirected to the
  // rookery-managed CODEX_HOME (auth.json provisioned via RPC); otherwise it inherits the user's ~/.codex.
  const codexApiKey = (): string | undefined => settings.codexApiKey();
  const codexEnv = (): NodeJS.ProcessEnv | undefined => {
    if (!settings.codexApiKey()) return undefined;
    fs.mkdirSync(codexHomeDir, { recursive: true });
    return { CODEX_HOME: codexHomeDir };
  };
  const prepareCodexWorker = (key: string, capabilities: import("../core/capabilities/types.js").ResolvedAgentCapabilities) => {
    const row = repos.getWorker(key);
    if (row?.sdk_session_id) {
      // Slice 4 migration: older workers wrote rollouts to either the API-key shared home or the
      // user's real home. Copy only this thread (plus ancestors) before the first isolated resume.
      const legacyHomes = [...new Set([codexHomeDir, realCodexHome])];
      for (const legacyHome of legacyHomes) {
        if (seedCodexWorkerHomeFromLegacy(config.home, key, row.sdk_session_id, legacyHome)) break;
      }
    }
    const managed = capabilityRuntime.materializeCodex(capabilities);
    const codexHome = materializeCodexHome(config.home, key, undefined, {
      kind: "worker",
      apiKeySet: !!settings.codexApiKey(),
      realCodexHome,
      managed,
    });
    return {
      codexHome,
      env: managed.env,
      ...(managed.systemPromptAppend ? { systemPromptAppend: managed.systemPromptAppend } : {}),
    };
  };
  const codexBackend = new CodexBackend({
    spawn: realCodexSpawn(() => settings.codexBin()),
    defaultModel: () => settings.codexWorkerModel(),
    apiKey: codexApiKey,
    // Per-turn inactivity watchdog (P2.5 Track B — docs/2026-07-06-p25-codex-hardening.md): resolved
    // fresh every turn, same as the other settings resolvers on this backend. 0/negative disables it
    // (see Settings.codexTurnIdleTimeoutMs's own comment for the fail-safe parse).
    idleTimeoutMs: () => settings.codexTurnIdleTimeoutMs(),
    // Pre-turn handshake+thread-start timeout (P3-remaining Track A — docs/2026-07-06-p3r-codex-hardening-finish.md):
    // resolved fresh per stream, same convention as idleTimeoutMs above. Covers openClient()+
    // startOrResumeThread(), a phase the idle watchdog above does NOT cover (it only arms after
    // turn/start's response).
    handshakeTimeoutMs: () => settings.codexHandshakeTimeoutMs(),
    env: codexEnv,
    runtime: {
      prepareWorker: prepareCodexWorker,
      prepareMaster: (key, defs, capabilities) => {
        const managed = capabilityRuntime.materializeCodex(capabilities);
        const { url } = bridge.ensureSession(key, defs);
        const codexHome = materializeCodexHome(config.home, key, url(config.host, boundPort), {
          apiKeySet: !!settings.codexApiKey(),
          realCodexHome,
          managed,
        });
        return {
          codexHome,
          env: managed.env,
          ...(managed.systemPromptAppend ? { systemPromptAppend: managed.systemPromptAppend } : {}),
        };
      },
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
          realCodexHome,
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
  const workflows = new ClaudeWorkflowRegistry({ files: realClaudeWorkflowFiles, bus });
  const subFactory = (o: { id: string; sessionId: string; repoPath: string; label: string; sdkSessionId?: string | null; model?: string; effort?: string; permissionMode?: string; onTurnStart?: () => void; maxTurns?: number; costBudgetUsd?: number; provider?: string; handoffSeed?: string; handoffFromProvider?: string }): WorkerLike =>
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
        managedCapabilities: () => capabilityService.resolveManaged({ kind: "worker", id: o.id }),
        capabilityRuntime: capabilityRuntimeState,
        workflowActivity: (o.provider ?? "claude") === "claude" ? workflows : undefined,
      },
      sdkSessionId: o.sdkSessionId ?? null,
      handoffSeed: o.handoffSeed, // cross-provider fork: seed the first turn's backend text
      handoffFromProvider: o.handoffFromProvider,
    });
  // Auto-generate labels (Haiku): workers right after spawn, masters from the first message. best-effort.
  const summarizeLabel = makeLabeler(queryFn);
  const fleet = new FleetOrchestrator({
    repos, bus, git, factory: subFactory, worktreesDir: config.fleet.worktreesDir, summarizeLabel,
    // Codex native forks must run in the SOURCE worker's isolated home. The new fork rollout and
    // its ancestors are then copied into the target home; target bindings compile lazily on resume.
    forkSession: async (provider, id, opts) => {
      if (provider !== "codex") return sdkForkSession(id, opts);
      const sourceWorkerId = opts?.sourceWorkerId;
      const newWorkerId = opts?.newWorkerId;
      if (!sourceWorkerId || !newWorkerId) throw new Error("cannot fork codex worker: missing source/new worker id");
      const capabilities = capabilityService.resolveManaged({ kind: "worker", id: sourceWorkerId });
      const source = prepareCodexWorker(sourceWorkerId, capabilities);
      const result = await codexBackend.forkSession(id, {
        env: { ...process.env, ...source.env, CODEX_HOME: source.codexHome },
      });
      seedCodexWorkerHomeFromSource(config.home, sourceWorkerId, newWorkerId, result.sessionId);
      return result;
    },
    onWorkerDiscard: (id, provider) => {
      if ((provider ?? repos.getWorker(id)?.provider ?? "claude") === "codex") removeCodexWorkerHome(config.home, id);
    },
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
  gcOrphanCodexHomes(
    config.home,
    new Set(repos.listSessions().map((s) => s.id)),
    new Set(repos.listAllWorkers().map((worker) => worker.id)),
  );
  // Slack holders (bridge / read ops / reporter-ensure) — installed by startSlack on connect, released
  // owner-scoped on stop (clearIf) so a stale connection's late stop can't clobber the live one's holders.
  const bridgeHolder = makeHolder<SlackInteractionBridge>();
  const slackReadOpsHolder = makeHolder<SlackReadOps>();
  const reporterHolder = makeHolder<(sessionId: string, externalKey: string) => void>();
  const nameResolverHolder = makeHolder<SlackRefResolver>();
  // For non-Slack (desktop/UI) sessions, canUseTool routes through a registry that surfaces it via EventBus→WS (Connection handles the respond).
  const interactionRegistry = new InteractionRegistry(bus);
  // P3 Track A (docs/2026-07-06-p3-codex-fork-automation.md): forks a codex MASTER session. Unlike
  // fleet's Codex fork (which runs in the source worker's isolated home), a Codex master's rollouts
  // live in a per-session CODEX_HOME — the fork child must run there
  // (thread/fork looks up threadId in the CWD it's spawned with), and the NEW session's home must be
  // pre-seeded with the source's sessions/ tree (parent + forked rollout) so context survives (the
  // forked rollout is a delta referencing the parent — see codex-home.ts seedCodexHomeFromSource).
  // Only reachable via SessionManager's forkSession router below.
  const forkCodexMaster = async (sourceThreadId: string, opts?: { sourceSessionId?: string; newSessionId?: string }): Promise<{ sessionId: string }> => {
    const sourceSessionId = opts?.sourceSessionId;
    const newSessionId = opts?.newSessionId;
    if (!sourceSessionId || !newSessionId) throw new Error("cannot fork codex session: missing sourceSessionId/newSessionId");
    const sourceHome = path.join(config.home, "codex-homes", sourceSessionId);
    if (!fs.existsSync(sourceHome)) throw new Error("cannot fork codex session: source CODEX_HOME missing (run a turn first)");
    // initialize loads the source home's managed MCP config even though thread/fork itself does not
    // call those tools. Supply the same alias values as a turn so required servers can initialize;
    // CodexBackend applies the fixed shell-snapshot/shell-env safety overrides automatically.
    const managed = capabilityRuntime.materializeCodex(capabilityService.resolveManaged({ kind: "session", id: sourceSessionId }));
    const { sessionId: forkedUuid } = await codexBackend.forkSession(sourceThreadId, {
      env: { ...process.env, ...managed.env, CODEX_HOME: sourceHome },
    });
    seedCodexHomeFromSource(config.home, sourceSessionId, newSessionId, forkedUuid);
    return { sessionId: forkedUuid };
  };
  const sessions = new SessionManager({ repos, bus, backends: { claude: backend, codex: codexBackend }, masterModel: () => settings.masterModel(), masterModelByProvider: { codex: () => settings.codexMasterModel() }, masterEffort: () => settings.masterEffort(), masterName: () => settings.masterName(), fleet, summarizeLabel, onSessionDelete,
    // Fork routing by provider: codex routes through forkCodexMaster (per-session CODEX_HOME
    // relocation, see above); claude keeps the SDK's own (eager) forkSession.
    forkSession: (provider, id, opts) => (provider === "codex" ? forkCodexMaster(id, opts) : sdkForkSession(id, opts)),
    makeCanUseTool: (externalKey, sessionId) => makeSlackCanUseTool(externalKey, () => bridgeHolder.get()) ?? interactionRegistry.canUseToolFor(sessionId),
    makeManagedCapabilities: (sessionId) => () => capabilityService.resolveManaged({ kind: "session", id: sessionId }),
    capabilityRuntime: capabilityRuntimeState,
    // Source-scoped dynamic capabilities: schedule_* tools for every master session (self-wakeup, backed by the daemon Scheduler) +
    // additionally compose the slack read tools/hint into slack thread sessions.
    // Schedule travels the toolDefs channel (not mcpServers): codex ignores opts.mcpServers (it has no
    // in-process MCP concept — see agent-backend.ts), so an opaque SDK server here would silently never
    // reach a codex master. toolDefs is the provider-neutral twin — master-agent.ts's doTurn merges it
    // into the same defs record the base memory/repos/fleet groups travel on, which the Claude adapter
    // wraps with createSdkMcpServer (same factory chain, same version "0.0.1", byte-equivalent server)
    // and the Codex adapter flattens onto the daemon MCP bridge, so codex masters now get schedule_* too.
    makeCapabilities: (externalKey, sessionId) => {
      const slackCaps = makeSlackCapabilities(externalKey, () => slackReadOpsHolder.get(), () => settings.masterName());
      return () => {
        const s = slackCaps?.() ?? {};
        return {
          ...s,
          toolDefs: { ...s.toolDefs, [SCHEDULE_SERVER_NAME]: scheduleToolDefs({ repos, reconcile: (id) => scheduler.reconcile(id), now: () => new Date() }, sessionId) },
          allowedTools: [...(s.allowedTools ?? []), ...SCHEDULE_TOOL_NAMES],
        };
      };
    } });
  const sides = new SideConversationManager({
    bus,
    backends: { claude: backend, codex: codexBackend },
    resolveSource: (sourceKind, sourceId): SideSource | undefined => {
      if (sourceKind === "master") {
        const row = repos.getSession(sourceId);
        if (!row) return undefined;
        const provider = row.provider || "claude";
        return {
          sourceKind, sourceId, sessionId: row.id, provider, cwd: row.cwd, sdkSessionId: row.sdk_session_id,
          model: provider === "codex" ? settings.codexMasterModel() : settings.masterModel(),
          effort: settings.masterEffort(),
        };
      }
      const row = repos.getWorker(sourceId);
      if (!row?.worktree_path) return undefined;
      const provider = row.provider || "claude";
      return {
        sourceKind, sourceId, sessionId: row.session_id, provider, cwd: row.worktree_path, sdkSessionId: row.sdk_session_id,
        model: row.model || (provider === "codex" ? settings.codexWorkerModel() : settings.workerModel()),
        effort: row.effort || settings.workerEffort(),
      };
    },
    forkSession: (source, sideId) => {
      if (source.provider !== "codex") return sdkForkSession(source.sdkSessionId!, { title: "Side question" });
      if (source.sourceKind === "master") {
        return forkCodexMaster(source.sdkSessionId!, { sourceSessionId: source.sourceId, newSessionId: sideId });
      }
      return codexBackend.forkSession(source.sdkSessionId!);
    },
    // Only a Codex master Side owns a per-side bridge registration/CODEX_HOME. Claude and Codex
    // worker Side conversations have no side-specific daemon resources to release.
    cleanup: (sideId, source) => { if (source.provider === "codex" && source.sourceKind === "master") onSessionDelete(sideId); },
  });
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
  // Codex usage for the desktop Usage panel's Codex tab — same spawn/env/apiKey closures as the
  // codex models/auth providers so it authenticates under the account the turns run under.
  const codexUsageProvider = makeCodexUsageProvider({ spawn: realCodexSpawn(() => settings.codexBin()), env: codexEnv, apiKey: codexApiKey });
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
    codexUsage: () => codexUsageProvider.fetch(),
  });
  usageCollector.start();
  const usageProvider = { snapshot: () => usageCollector.snapshot() };
  // List of available models (for the settings picker): x-api-key if there's an API key, otherwise the Claude Code OAuth token (same token reader as usage). Static fallback on failure.
  const modelsList = makeModelsProvider({ apiKey: () => settings.anthropicApiKey() });
  const modelsProvider = { list: () => modelsList() };
  // Codex model/effort catalog (for the desktop Codex model picker): spawns a short-lived app-server
  // child and caches the first successful result for the daemon's lifetime (see codex-models-provider.ts).
  const codexModelsProvider = makeCodexModelsProvider({ spawn: realCodexSpawn(() => settings.codexBin()), env: codexEnv, apiKey: codexApiKey });
  // Codex auth-readiness probe (for the desktop Settings Codex sub-tab): spawns a short-lived app-server
  // child and reads its account state. NOT cached (auth changes at runtime) — see codex-auth-provider.ts.
  const codexAuthProvider = makeCodexAuthProvider({ spawn: realCodexSpawn(() => settings.codexBin()), env: codexEnv, apiKey: codexApiKey });
  // Read-only provider-neutral inventory for Capability Center. Codex structured probes share the
  // same binary/auth environment as turns; master targets override CODEX_HOME with their materialized
  // per-session home when one exists so the snapshot observes the same config/MCP/skills as the turn.
  const codexCapabilitiesProvider = makeCodexCapabilitiesProvider({ spawn: realCodexSpawn(() => settings.codexBin()), env: codexEnv, apiKey: codexApiKey });
  capabilityService = new CapabilityService({
    getSession: (id) => {
      const row = repos.getSession(id);
      return row ? {
        id: row.id,
        cwd: row.cwd,
        label: row.label,
        provider: row.provider,
        origin: row.origin,
        externalKey: row.external_key,
      } : undefined;
    },
    getWorker: (id) => {
      const row = repos.getWorker(id);
      return row ? {
        id: row.id,
        worktreePath: row.worktree_path,
        repoPath: row.repo_path,
        label: row.label,
        provider: row.provider,
        homeSessionId: row.session_id,
      } : undefined;
    },
    listRepos: () => repos.listRepos().map((repo) => ({ id: repo.id, path: repo.path, name: repo.name })),
    listClaudeCommands: async ({ target, cwd }) => {
      if (target.kind === "worker") {
        const live = await fleet.listCommands(target.id);
        if (live.length > 0) return { commands: live };
      }
      return commandCatalog.inspect(cwd);
    },
    listCodexCapabilities: ({ cwd, env }) => codexCapabilitiesProvider.list({ cwd, ...(env ? { env } : {}) }),
    codexEnvForTarget: (target) => {
      const targetHome = codexHomeDirFor(config.home, target.id, target.kind === "worker" ? "worker" : "master");
      if (!fs.existsSync(targetHome)) return undefined;
      // Probe with the current desired aliases when available. The target home itself is never
      // rewritten from this read path, so applied-vs-desired drift remains truthful.
      try {
        const managed = capabilityRuntime.materializeCodex(capabilityService.resolveManaged(target));
        return { ...managed.env, CODEX_HOME: targetHome };
      } catch {
        return { CODEX_HOME: targetHome };
      }
    },
    registry: capabilityRegistry,
    generatedPacks: generatedCapabilityPacks,
    resolver: capabilityResolver,
    runtimeState: capabilityRuntimeState,
  });
  const capabilityRepoWatcher = new CapabilityRepoWatcher(repos, capabilityRegistry);
  capabilityRepoWatcher.start();
  const liveCapabilityRevisions = new Set<string>();
  for (const session of repos.listSessions()) {
    try { liveCapabilityRevisions.add(capabilityService.resolveManaged({ kind: "session", id: session.id }).revision); }
    catch { /* a corrupt target must not prevent cleanup of independently valid revisions */ }
  }
  for (const worker of repos.listAllWorkers()) {
    try { liveCapabilityRevisions.add(capabilityService.resolveManaged({ kind: "worker", id: worker.id }).revision); }
    catch { /* a corrupt target must not prevent cleanup of independently valid revisions */ }
  }
  gcCapabilityRuntime(config.home, liveCapabilityRevisions);

  // External MCP server (rookery-as-MCP): a SECOND McpBridge mounted at /mcp-ext, gating fleet control for
  // external MCP clients (Claude Code/Cursor/Codex). Off by default (fail-closed) via the mcpExposure setting;
  // reconcile() runs at boot and on every settings.set that touches mcpExposure (Connection). port reads the
  // live boundPort so ephemeral (port 0) test/dev binds still advertise the real URL.
  const extMcp = new ExternalMcpController({
    tokenPath: config.mcpTokenPath,
    host: config.host,
    port: () => boundPort,
    scope: () => settings.mcpExposure(),
    defsFor: (scope) => externalToolDefs({ fleet, repos, sessions }, scope) as unknown as import("./mcp-bridge.js").BridgeToolDef[],
  });
  extMcp.reconcile();

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
    name: settings.masterName(), // Slack thread title + greeting (masterName surfaces)
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
  // Trigger source ③ worker-settled: fires `worker`-kind automations when a fleet worker settles
  // (idle/stopped/failure buckets; automation-spawned workers excluded — see worker-trigger-source.ts).
  const stopWorkerTrigger = startWorkerTriggerSource({ repos, dispatcher, bus });

  const slack = new SlackController({
    configured: () => settings.slackConfigured(), // resolver, since tokens can change at runtime
    enabled: () => repos.getSetting("slackEnabled") !== "0", // on by default
    setEnabled: (b) => repos.setSetting("slackEnabled", b ? "1" : "0"),
    start: () => startSlack({ sessions, bus, slackConfig, home: config.home,
      setBridge: (b) => { if (b) bridgeHolder.set(b); },
      clearBridge: (b) => bridgeHolder.clearIf(b),
      setSlackReadOps: (r) => { if (r) slackReadOpsHolder.set(r); },
      clearSlackReadOps: (r) => slackReadOpsHolder.clearIf(r),
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
    // External MCP server (rookery-as-MCP) at /mcp-ext/<token>. Off → its session isn't registered, so this 404s.
    if (extMcp.handleHttp(req, res)) return;
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
    const conn = new Connection({ send }, sessions, bus, fleet, repos, usageProvider, settings, commandCatalog, sourceProvider, slack, modelsProvider, interactionRegistry, automationProvider, resolveSlackRefs, codexModelsProvider, codexAuthProvider, extMcp, sides, capabilityService, workflows);
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
    stopWorkerTrigger(); // same rationale: fleet.close's synchronous 'stopped' emits must not fire automations mid-shutdown
    usageCollector.stop();
    scheduler.stop();
    clearInterval(heartbeat);
    await slack.stop(); // stop accepting new Slack-triggered turns before draining the in-flight ones
    // Close the ADMISSION path first: terminate the desktop WS clients and close the WS server, so no client
    // can start a fresh turn (session.send / fleet.spawn) during the drain below that would then race
    // db.close() — this is the original ordering's admission guarantee, preserved. Crucially this does NOT
    // kill the codex MCP bridge: the bridge is plain HTTP handled by httpServer (still listening until the
    // teardown further down), a SEPARATE channel from these WebSocket sockets, so wss.close() leaves it
    // reachable. (In noServer mode wss is attached via httpServer's 'upgrade' event and does not own it.)
    for (const ws of wss.clients) ws.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
    await sides.closeAll();
    // Now finish in-flight writes before db.close() (G-SHUTDOWN-RACE): stop live workers + drain master
    // turns. This runs while httpServer is STILL listening (finding [15]): a codex master turn reaches its
    // in-process tools over the MCP bridge on that http server, so the bridge must stay reachable for the
    // drain grace window — otherwise an in-flight codex turn loses tool connectivity mid-tool-call, hangs on
    // its idle watchdog until the drain times out, and its late persistence then races db.close(). A Claude
    // master turn (in-process SDK MCP) doesn't need the http server, so this only helps.
    await fleet.close(5000);
    await workflows.close();
    await sessions.drain(5000);
    capabilityRepoWatcher.close();
    // Drain done → tear down the http server (and with it the now-idle MCP bridge), then close the DB last.
    httpServer.closeAllConnections?.(); // Node 18.2+: forcibly close any remaining keep-alive connections
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
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
