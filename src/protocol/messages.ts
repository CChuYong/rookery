import { z } from "zod";
import type { CoreEvent, SlackStatus } from "../core/events.js";
import type { UsageSnapshot } from "../core/usage.js";
import type { SettingsValues } from "../core/settings.js";
import type { SlashCommandInfo } from "../core/commands.js";
import type { SourceItem } from "../core/source-intake.js";
import type { AuthStatus } from "../core/auth-status.js";
import type { Automation, AutomationInput } from "../persistence/repositories.js";
import { isValidCron } from "../core/cron.js";

// effort validation: allow only valid members (reject invalid values), but keep the inferred type as string (compatible with SettingsValues).
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const effortField = z.string().refine((v) => EFFORT_LEVELS.includes(v), { message: "invalid effort" }).nullable().optional();

const triggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cron"), cron: z.string(), timezone: z.string() }),
  z.object({ kind: z.literal("slack"), channels: z.array(z.string()).optional(), keyword: z.string().optional(), fromUsers: z.array(z.string()).optional() }),
]);

const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("master"), prompt: z.string(), cwd: z.string(), sessionMode: z.enum(["reuse", "fresh"]) }),
  z.object({ kind: z.literal("worker"), repo: z.string(), task: z.string(), base: z.string().optional() }),
]);

const automationInputSchema = z.object({
  name: z.string(),
  enabled: z.boolean().optional(),
  trigger: triggerSchema,
  action: actionSchema,
  model: z.string().nullable().optional(),
  effort: effortField,
  permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan"]).nullable().optional(),
  maxTurns: z.number().int().positive().nullable().optional(),
  // Lifetime USD cost ceiling — the sibling runaway guard to maxTurns (see workers.cost_budget_usd). NULL = unlimited.
  costBudgetUsd: z.number().positive().nullable().optional(),
  // Which AgentBackend runs sessions/workers created by this automation. Optional; defaults to "claude" on write
  // (see Repositories.createAutomation). Not nullable — an automation always has a definite backend.
  provider: z.enum(["claude", "codex"]).optional(),
}).superRefine((v, ctx) => {
  if (v.trigger.kind === "cron" && !isValidCron(v.trigger.cron, v.trigger.timezone)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "invalid cron expression", path: ["trigger", "cron"] });
  }
});

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.create"), cwd: z.string().optional(), provider: z.enum(["claude", "codex"]).optional(), reqId: z.string().optional() }),
  z.object({ type: z.literal("session.fork"), sessionId: z.string(), reqId: z.string().optional() }),
  z.object({ type: z.literal("session.open"), key: z.string(), cwd: z.string().optional(), reqId: z.string().optional() }),
  z.object({ type: z.literal("session.attach"), sessionId: z.string() }),
  // model/effort/permissionMode: per-session UI overrides (independent of the default settings). If unspecified, fall back to the global defaults (permissionMode is bypassPermissions).
  z.object({ type: z.literal("session.send"), sessionId: z.string(), text: z.string(), model: z.string().optional(), effort: z.string().optional(), permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan"]).optional(), clientMsgId: z.string().optional(), reqId: z.string().optional() }),
  z.object({ type: z.literal("session.stop"), sessionId: z.string(), reqId: z.string().optional() }),
  // Master canUseTool (approval/AskUserQuestion) response — resolves the pending interaction by requestId (=toolUseID).
  z.object({
    type: z.literal("interaction.respond"),
    requestId: z.string(),
    decision: z.enum(["allow", "deny"]).optional(), // approval card
    answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])).optional(), // AskUserQuestion card
    reqId: z.string().optional(),
  }),
  z.object({ type: z.literal("session.delete"), reqId: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal("session.archive"), reqId: z.string(), sessionId: z.string(), archived: z.boolean() }),
  z.object({ type: z.literal("session.rename"), reqId: z.string(), sessionId: z.string(), label: z.string() }),
  z.object({ type: z.literal("session.pin"), reqId: z.string(), sessionId: z.string(), pinned: z.boolean() }),
  z.object({ type: z.literal("worker.archive"), reqId: z.string(), id: z.string(), archived: z.boolean() }),
  z.object({ type: z.literal("worker.rename"), reqId: z.string(), id: z.string(), label: z.string() }),
  z.object({ type: z.literal("worker.delete"), reqId: z.string(), id: z.string() }),
  z.object({ type: z.literal("session.list"), reqId: z.string().optional() }),
  z.object({ type: z.literal("worker.list"), sessionId: z.string(), reqId: z.string().optional() }),
  z.object({ type: z.literal("fleet.list"), reqId: z.string() }),
  z.object({ type: z.literal("fleet.diff"), reqId: z.string(), id: z.string() }),
  z.object({ type: z.literal("fleet.stop"), reqId: z.string(), id: z.string() }),
  z.object({ type: z.literal("fleet.discard"), reqId: z.string(), id: z.string() }),
  z.object({ type: z.literal("fleet.subscribe") }),
  z.object({ type: z.literal("events.subscribe") }),
  z.object({ type: z.literal("repos.list"), reqId: z.string() }),
  z.object({ type: z.literal("repo.branches"), reqId: z.string(), repo: z.string() }),
  z.object({ type: z.literal("source.fetch"), reqId: z.string(), url: z.string() }),
  z.object({ type: z.literal("source.search"), reqId: z.string(), provider: z.enum(["github", "linear"]), query: z.string(), repo: z.string().optional() }),
  z.object({ type: z.literal("integrations.status"), reqId: z.string() }),
  z.object({ type: z.literal("auth.status"), reqId: z.string() }),
  z.object({ type: z.literal("repos.register"), reqId: z.string(), name: z.string(), path: z.string(), description: z.string(), base: z.string().optional() }),
  z.object({ type: z.literal("repos.update"), reqId: z.string(), name: z.string(), description: z.string().optional(), base: z.string().optional() }),
  z.object({ type: z.literal("repos.remove"), reqId: z.string(), name: z.string() }),
  z.object({ type: z.literal("session.history"), reqId: z.string(), sessionId: z.string() }),
  z.object({ type: z.literal("worker.history"), reqId: z.string(), id: z.string() }),
  z.object({ type: z.literal("worker.send"), id: z.string(), text: z.string(), clientMsgId: z.string().optional(), reqId: z.string().optional() }),
  // Live-change the model of a running worker (query.setModel).
  z.object({ type: z.literal("worker.setModel"), id: z.string(), model: z.string(), reqId: z.string().optional() }),
  // Live-change the permission mode of a running worker (query.setPermissionMode). Only bypassPermissions/plan (no default/acceptEdits).
  z.object({ type: z.literal("worker.setPermissionMode"), id: z.string(), permissionMode: z.enum(["bypassPermissions", "plan"]), reqId: z.string().optional() }),
  // Interrupt the worker's current turn (query.interrupt) — keeps the session alive, further instructions possible. The worker-side counterpart of the master's session.stop.
  z.object({ type: z.literal("worker.interrupt"), id: z.string(), reqId: z.string().optional() }),
  z.object({ type: z.literal("worker.checkpoints"), reqId: z.string(), id: z.string() }),
  z.object({ type: z.literal("worker.restore"), reqId: z.string(), id: z.string(), seq: z.number() }),
  z.object({ type: z.literal("worker.fork"), reqId: z.string(), id: z.string() }),
  z.object({ type: z.literal("fleet.spawn"), reqId: z.string(), repo: z.string(), task: z.string().optional(), label: z.string().optional(), model: z.string().optional(), effort: z.string().optional(), permissionMode: z.enum(["bypassPermissions", "plan"]).optional(), base: z.string().optional(), ticketKey: z.string().optional(), ticketUrl: z.string().optional(), provider: z.enum(["claude", "codex"]).optional(), costBudgetUsd: z.number().positive().nullable().optional() }),
  // Slash command/skill candidates. If workerId is given, probe within that live session; otherwise probe by cwd.
  z.object({ type: z.literal("commands.list"), reqId: z.string(), cwd: z.string().optional(), workerId: z.string().optional(), provider: z.enum(["claude", "codex"]).optional() }),
  z.object({ type: z.literal("usage.get"), reqId: z.string() }),
  z.object({ type: z.literal("models.list"), reqId: z.string() }),
  z.object({ type: z.literal("codex.models.list"), reqId: z.string() }),
  z.object({ type: z.literal("settings.get"), reqId: z.string() }),
  z.object({
    type: z.literal("settings.set"),
    reqId: z.string(),
    // nullable: an explicit null clears that setting, reverting to the config default (to reach apply's deleteSetting path).
    // effort is validated via a membership refine (rejecting invalid values) — but the type stays string so it stays
    // compatible with SettingsValues (string). With z.enum it would be a union type, which breaks passing SettingsValues from the type-safe client (desktop).
    settings: z.object({
      masterName: z.string().nullable().optional(), // Bot name. null/empty string → delete key → fall back to the default (rookery).
      masterModel: z.string().nullable().optional(),
      workerModel: z.string().nullable().optional(),
      codexWorkerModel: z.string().nullable().optional(), // codex worker default model (settings-only)
      codexMasterModel: z.string().nullable().optional(), // codex master default model (settings-only)
      codexBin: z.string().nullable().optional(), // codex CLI binary/path used to spawn `codex app-server`
      codexTurnIdleTimeoutMs: z.string().nullable().optional(), // per-turn codex watchdog inactivity timeout (ms); 0 disables
      codexHandshakeTimeoutMs: z.string().nullable().optional(), // pre-turn codex handshake+thread-start timeout (ms); 0 disables
      masterEffort: effortField,
      workerEffort: effortField,
      slackCwd: z.string().nullable().optional(), // Slack session cwd
      slackAllowedUsers: z.string().nullable().optional(), // allowed user ids (comma-separated)
      slackAllowAll: z.string().nullable().optional(), // "1"/"0"
      slackRefuseReply: z.string().nullable().optional(), // whether to auto-reply on refusal "1"/"0"
      slackRefusalMessage: z.string().nullable().optional(), // refusal reply message
      slackLocale: z.string().nullable().optional(), // Slack output language "ko"/"en"
      slackProvider: z.string().nullable().optional(), // AgentBackend for slack-origin sessions "claude"/"codex" (settings-only, default "claude")
      usageRefreshMs: z.string().nullable().optional(), // usage refresh interval (ms)
      linearApiKey: z.string().nullable().optional(), // write-only secret key. Not echoed back in settings.result.
      anthropicApiKey: z.string().nullable().optional(), // write-only secret. Not echoed in settings.result.
      codexApiKey: z.string().nullable().optional(), // write-only secret (codex in-app API key). Not echoed in settings.result.
      hasAcceptedDataNotice: z.string().optional(), // first-run data-transmission consent flag ("1"/"0"). Echoed.
      onboardingDone: z.string().optional(), // first-run onboarding completed flag ("1"/"0"). Echoed.
      defaultSessionCwd: z.string().nullable().optional(), // default cwd for desktop sessions when none is picked. Echoed.
      workerSlackRelayEnabled: z.string().optional(), // mirror worker activity to a Slack channel ("1"/"0"). Echoed.
      workerSlackRelayChannel: z.string().nullable().optional(), // Slack channel ID for the worker relay. Echoed.
      workerCostBudgetUsd: z.string().nullable().optional(), // default lifetime USD cost ceiling for spawned workers ("" = unlimited). Echoed.
      slackBotToken: z.string().nullable().optional(), // write-only secret. Not echoed.
      slackAppToken: z.string().nullable().optional(), // write-only secret. Not echoed.
    }),
  }),
  z.object({ type: z.literal("slack.set"), enabled: z.boolean(), reqId: z.string().optional() }),
  z.object({ type: z.literal("automation.list"), reqId: z.string() }),
  z.object({ type: z.literal("automation.create"), reqId: z.string(), automation: automationInputSchema }),
  z.object({ type: z.literal("automation.update"), reqId: z.string(), id: z.string(), patch: automationInputSchema }),
  z.object({ type: z.literal("automation.delete"), reqId: z.string(), id: z.string() }),
  z.object({
    type: z.literal("automation.run"), reqId: z.string(), id: z.string(),
    vars: z.object({ message: z.string(), channel: z.string(), user: z.string(), ts: z.string(), threadTs: z.string(), team: z.string() }).partial().optional(),
  }),
  z.object({ type: z.literal("automation.set_enabled"), reqId: z.string(), id: z.string(), enabled: z.boolean() }),
  // Best-effort Slack channel/user id → display name resolution for automation rule cards (audit #51). Never blocks
  // automation.list; on any failure or a disconnected/unconfigured Slack adapter, ids are simply omitted from the result.
  z.object({ type: z.literal("automation.resolveSlackRefs"), reqId: z.string(), channels: z.array(z.string()).optional(), users: z.array(z.string()).optional() }),
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;

// Worker row — the single definition for fleet/worker lists (previously inlined and duplicated across worker.list.result and fleet.list.result).
// pr_url removed because, with no automatic PR pipeline, it was always null (P1 leftover cleanup).
export interface WorkerRow {
  id: string;
  label: string;
  repoPath: string;
  status: string;
  branch: string | null;
  model: string | null;
  permissionMode?: string | null; // SDK permission mode (bypassPermissions | plan). Optional for back-compat; the desktop defaults it to bypassPermissions when absent.
  provider?: string; // which AgentBackend runs this worker ('claude' | 'codex'). Optional for back-compat; the desktop defaults it to 'claude' when absent.
  ticketKey?: string | null; // spawn-source ticket/issue identifier (ENG-123, #456). Header shortcut button. The daemon always sends it (may be null).
  ticketUrl?: string | null;
  lastActivityTs?: number; // ms epoch of the worker's last message event (fleet.list snapshot); absent if it has none
  costUsd?: number;        // cumulative $ from the worker's last result event; absent if it never completed a turn
  maxTurns?: number | null; // per-result turn cap (runaway guard) persisted on the worker; null/absent = no cap
  costBudgetUsd?: number | null; // explicit per-worker lifetime USD ceiling override; null/absent = no per-worker override (the workerCostBudgetUsd settings default may still apply — see server.ts subFactory)
}

// Integration connection status (on-demand pull). github=gh auth, linear=key present + viewer verification.
export interface IntegrationsStatus {
  github: { available: boolean; user?: string };
  linear: { configured: boolean; valid?: boolean; user?: string };
}

// One available Codex model (from the app-server's `model/list` catalog) — structurally identical to
// core/codex-models-provider.ts's CodexModelInfo, but re-declared here (not imported) so the protocol
// stays transport-agnostic (no core import in messages.ts).
export interface CodexModelInfo {
  id: string;
  displayName: string;
  defaultEffort: string;
  supportedEfforts: string[];
  isDefault: boolean;
}

export type ServerMessage =
  | { type: "session.created"; sessionId: string; cwd: string; reqId?: string }
  | { type: "session.list.result"; sessions: Array<{ id: string; cwd: string; status: string; lastActivity: string; origin: string; originRef: string | null; label: string | null; archived: boolean; pinned: boolean; provider?: string }>; reqId?: string }
  | { type: "worker.list.result"; sessionId: string; reqId?: string; workers: WorkerRow[] }
  | { type: "event"; event: CoreEvent }
  | { type: "error"; message: string; reqId?: string }
  | { type: "fleet.list.result"; reqId: string; fleet: Array<WorkerRow & { archived: boolean }> }
  | { type: "fleet.diff.result"; reqId: string; id: string; diff: string }
  | { type: "fleet.ack"; reqId: string; action: string; id: string }
  | { type: "repos.list.result"; reqId: string; repos: Array<{ name: string; path: string; description: string; base: string | null }> }
  | { type: "repo.branches.result"; reqId: string; branches: string[] }
  | { type: "source.fetch.result"; reqId: string; item: { title: string; body: string } | null }
  | { type: "source.search.result"; reqId: string; items: SourceItem[] }
  | ({ type: "integrations.status.result"; reqId: string } & IntegrationsStatus)
  | ({ type: "auth.status.result"; reqId: string } & AuthStatus)
  | { type: "repos.ack"; reqId: string; action: string; name: string }
  | { type: "session.history.result"; reqId: string; sessionId: string; events: Array<{ seq: number; type: string; payload: unknown; createdAt: string }> }
  | { type: "worker.history.result"; reqId: string; id: string; events: Array<{ seq: number; type: string; payload: unknown; createdAt: string }> }
  | { type: "worker.checkpoints.result"; reqId: string; id: string; checkpoints: Array<{ seq: number; sha: string; createdAt: string }> }
  | { type: "fleet.spawn.result"; reqId: string; id: string }
  | { type: "usage.result"; reqId: string; usage: UsageSnapshot }
  | { type: "models.result"; reqId: string; models: Array<{ id: string; displayName: string }> }
  | { type: "codex.models.result"; reqId: string; models: CodexModelInfo[] | null }
  | { type: "commands.result"; reqId: string; commands: SlashCommandInfo[] }
  | { type: "settings.result"; reqId: string; settings: SettingsValues }
  | { type: "slack.ack"; reqId?: string; status: SlackStatus }
  | { type: "automation.list.result"; reqId: string; automations: Automation[] }
  | { type: "automation.result"; reqId: string; automation: Automation }
  | { type: "automation.resolveSlackRefs.result"; reqId: string; channels: Record<string, string>; users: Record<string, string> };

// Request (a request that gets a response via reqId) type → response ServerMessage mapping — **single source**.
// Must be 1:1 with the reply types in the daemon's connection.ts (when adding a new request, add it here too → WsClient.request stays type-safe).
// fire-and-forget (send: session.attach, *.subscribe) is excluded since it has no response.
// Mutations without their own ack (session/worker delete, archive, rename, restore, session.stop, session.send, worker.setModel/setPermissionMode) all respond with fleet.ack.
export interface RequestResultMap {
  "session.create": Extract<ServerMessage, { type: "session.created" }>;
  "session.open": Extract<ServerMessage, { type: "session.created" }>;
  "session.fork": Extract<ServerMessage, { type: "session.created" }>;
  "session.send": Extract<ServerMessage, { type: "fleet.ack" }>;
  "session.stop": Extract<ServerMessage, { type: "fleet.ack" }>;
  "session.rename": Extract<ServerMessage, { type: "fleet.ack" }>;
  "session.archive": Extract<ServerMessage, { type: "fleet.ack" }>;
  "session.pin": Extract<ServerMessage, { type: "fleet.ack" }>;
  "session.delete": Extract<ServerMessage, { type: "fleet.ack" }>;
  "worker.rename": Extract<ServerMessage, { type: "fleet.ack" }>;
  "worker.archive": Extract<ServerMessage, { type: "fleet.ack" }>;
  "worker.delete": Extract<ServerMessage, { type: "fleet.ack" }>;
  "worker.send": Extract<ServerMessage, { type: "fleet.ack" }>;
  "worker.setModel": Extract<ServerMessage, { type: "fleet.ack" }>;
  "worker.setPermissionMode": Extract<ServerMessage, { type: "fleet.ack" }>;
  "worker.restore": Extract<ServerMessage, { type: "fleet.ack" }>;
  "worker.fork": Extract<ServerMessage, { type: "fleet.spawn.result" }>;
  "session.list": Extract<ServerMessage, { type: "session.list.result" }>;
  "worker.list": Extract<ServerMessage, { type: "worker.list.result" }>;
  "fleet.list": Extract<ServerMessage, { type: "fleet.list.result" }>;
  "fleet.diff": Extract<ServerMessage, { type: "fleet.diff.result" }>;
  "fleet.stop": Extract<ServerMessage, { type: "fleet.ack" }>;
  "fleet.discard": Extract<ServerMessage, { type: "fleet.ack" }>;
  "worker.interrupt": Extract<ServerMessage, { type: "fleet.ack" }>;
  "fleet.spawn": Extract<ServerMessage, { type: "fleet.spawn.result" }>;
  "repos.list": Extract<ServerMessage, { type: "repos.list.result" }>;
  "repo.branches": Extract<ServerMessage, { type: "repo.branches.result" }>;
  "source.fetch": Extract<ServerMessage, { type: "source.fetch.result" }>;
  "source.search": Extract<ServerMessage, { type: "source.search.result" }>;
  "integrations.status": Extract<ServerMessage, { type: "integrations.status.result" }>;
  "auth.status": Extract<ServerMessage, { type: "auth.status.result" }>;
  "repos.register": Extract<ServerMessage, { type: "repos.ack" }>;
  "repos.update": Extract<ServerMessage, { type: "repos.ack" }>;
  "repos.remove": Extract<ServerMessage, { type: "repos.ack" }>;
  "session.history": Extract<ServerMessage, { type: "session.history.result" }>;
  "worker.history": Extract<ServerMessage, { type: "worker.history.result" }>;
  "worker.checkpoints": Extract<ServerMessage, { type: "worker.checkpoints.result" }>;
  "usage.get": Extract<ServerMessage, { type: "usage.result" }>;
  "models.list": Extract<ServerMessage, { type: "models.result" }>;
  "codex.models.list": Extract<ServerMessage, { type: "codex.models.result" }>;
  "commands.list": Extract<ServerMessage, { type: "commands.result" }>;
  "settings.get": Extract<ServerMessage, { type: "settings.result" }>;
  "settings.set": Extract<ServerMessage, { type: "settings.result" }>;
  "slack.set": Extract<ServerMessage, { type: "slack.ack" }>;
  "automation.list": Extract<ServerMessage, { type: "automation.list.result" }>;
  "automation.create": Extract<ServerMessage, { type: "automation.result" }>;
  "automation.update": Extract<ServerMessage, { type: "automation.result" }>;
  "automation.set_enabled": Extract<ServerMessage, { type: "automation.result" }>;
  "automation.delete": Extract<ServerMessage, { type: "fleet.ack" }>;
  "automation.run": Extract<ServerMessage, { type: "fleet.ack" }>;
  "automation.resolveSlackRefs": Extract<ServerMessage, { type: "automation.resolveSlackRefs.result" }>;
}

export type RequestType = keyof RequestResultMap;
// Since request() injects the reqId, the caller passes it without a reqId.
export type RequestInput<K extends RequestType> = Omit<Extract<ClientMessage, { type: K }>, "reqId"> & { type: K };

export function parseClientMessage(raw: string): ClientMessage {
  const json = JSON.parse(raw) as unknown;
  return clientMessageSchema.parse(json);
}

export function serializeServerMessage(msg: ServerMessage): string {
  return JSON.stringify(msg);
}
