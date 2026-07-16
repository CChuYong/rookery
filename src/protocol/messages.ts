import { z } from "zod";
import type { CoreEvent, SlackStatus } from "../core/events.js";
import type { UsageSnapshot } from "../core/usage.js";
import type { SettingsValues } from "../core/settings.js";
import type { CommandCandidate } from "../core/capabilities/commands.js";
import type { SourceItem } from "../core/source-intake.js";
import type { AuthStatus } from "../core/auth-status.js";
import type {
  CapabilityBinding,
  CapabilityCatalogCreateResult,
  CapabilityLibraryEntry,
  CapabilityLibrarySnapshot,
  CapabilityMcpPackCreateResult,
  CapabilitySecretStatus,
  CapabilitySnapshot,
} from "../core/capabilities/types.js";
import type { Automation, AutomationInput } from "../persistence/repositories.js";
import { isValidCron } from "../core/cron.js";
import type { WorkflowAgentHistoryEntry, WorkflowRunSnapshot } from "../core/workflow-activity.js";

// effort validation: allow only valid members (reject invalid values), but keep the inferred type as string (compatible with SettingsValues).
const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];
const effortField = z.string().refine((v) => EFFORT_LEVELS.includes(v), { message: "invalid effort" }).nullable().optional();

const triggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("cron"), cron: z.string(), timezone: z.string() }),
  z.object({ kind: z.literal("interval"), everyMinutes: z.number().int().positive() }), // "every N minutes" (min 1; the scheduler tick is 30s)
  z.object({ kind: z.literal("slack"), channels: z.array(z.string()).optional(), keyword: z.string().optional(), fromUsers: z.array(z.string()).optional() }),
  // Worker-settled trigger: on = settle buckets (absent/empty → ["stopped","failure"]; idle is opt-in).
  z.object({ kind: z.literal("worker"), repo: z.string().optional(), on: z.array(z.enum(["idle", "stopped", "failure"])).optional(), label: z.string().optional() }),
]);

const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("master"), prompt: z.string(), cwd: z.string(), sessionMode: z.enum(["reuse", "fresh"]) }),
  z.object({ kind: z.literal("worker"), repo: z.string(), task: z.string(), base: z.string().optional() }),
]);

const capabilityIdSchema = z.string().trim().min(1);
const capabilityScopeKindSchema = z.enum(["rookery", "repo-local", "repo-shared", "session", "worker"]);
const capabilityAudienceSchema = z.object({
  agents: z.array(z.enum(["master", "worker", "side"])).min(1),
  origins: z.array(z.enum(["ui", "slack", "automation", "external"])).min(1),
}).strict();
const capabilityBindingInputSchema = z.object({
  packInstanceId: capabilityIdSchema,
  scopeKind: capabilityScopeKindSchema,
  scopeRef: z.string(),
  audience: capabilityAudienceSchema,
  enabled: z.boolean(),
}).strict().superRefine((binding, context) => {
  if (binding.scopeKind === "rookery" && binding.scopeRef !== "") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["scopeRef"], message: "rookery scopeRef must be empty" });
  }
  if (binding.scopeKind !== "rookery" && !binding.scopeRef.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["scopeRef"], message: `${binding.scopeKind} scopeRef must not be empty` });
  }
});

const capabilityMcpIdSchema = z.string().trim().regex(
  /^[a-z0-9][a-z0-9._-]{0,63}$/,
  "must match /^[a-z0-9][a-z0-9._-]{0,63}$/",
);
const capabilitySecretKeySchema = z.string().trim().regex(
  /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/,
  "must be a valid secret key",
);
const capabilityEnvNameSchema = z.string().trim().regex(
  /^[A-Za-z_][A-Za-z0-9_]*$/,
  "must be a valid environment variable name",
);
const capabilityRelativePathSchema = z.string().trim().min(1).refine((value) => {
  if (value.includes("\0") || value.includes("\\")) return false;
  if (value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value)) return false;
  return !value.split("/").some((part) => part === "..");
}, "must be a portable relative path inside the pack root").transform((value) => value.replace(/^\.\/+/, ""));
const capabilitySecretRefSchema = z.discriminatedUnion("source", [
  z.object({ source: z.literal("rookery-secret"), key: capabilitySecretKeySchema }).strict(),
  z.object({ source: z.literal("environment"), name: capabilityEnvNameSchema }).strict(),
]);
const capabilityStringMapSchema = z.record(z.string().min(1), z.string());
const capabilitySecretMapSchema = z.record(z.string().min(1), capabilitySecretRefSchema);
const capabilityToolListSchema = z.array(z.string().trim().min(1)).max(1_000)
  .transform((values) => [...new Set(values)].sort());
const capabilityMcpCommonShape = {
  id: capabilityMcpIdSchema,
  enabledTools: capabilityToolListSchema.optional(),
  disabledTools: capabilityToolListSchema.optional(),
  required: z.boolean().optional(),
  startupTimeoutSec: z.number().int().min(1).max(120).optional(),
  toolTimeoutSec: z.number().int().min(1).max(600).optional(),
};
const capabilityStdioMcpSchema = z.object({
  ...capabilityMcpCommonShape,
  transport: z.literal("stdio"),
  command: z.string().trim().min(1).max(4_096),
  args: z.array(z.string().max(16_384)).max(1_000).optional(),
  cwd: capabilityRelativePathSchema.optional(),
  env: capabilityStringMapSchema.optional(),
  secretEnv: capabilitySecretMapSchema.optional(),
}).strict();
const capabilityHttpMcpSchema = z.object({
  ...capabilityMcpCommonShape,
  transport: z.literal("streamable-http"),
  url: z.string().trim().min(1).max(8_192).refine((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }, "must be an HTTP or HTTPS URL"),
  headers: capabilityStringMapSchema.optional(),
  secretHeaders: capabilitySecretMapSchema.optional(),
  auth: z.object({ bearerToken: capabilitySecretRefSchema }).strict().optional(),
}).strict();
const capabilityMcpServerSchema = z.discriminatedUnion("transport", [
  capabilityStdioMcpSchema,
  capabilityHttpMcpSchema,
]);
const capabilitySecretValuesSchema = z.record(
  capabilitySecretKeySchema,
  z.string().max(1_048_576).refine((value) => value.trim().length > 0, "secret value must not be empty"),
);

function declaredMcpSecretKeys(server: z.infer<typeof capabilityMcpServerSchema>): Set<string> {
  const keys = new Set<string>();
  const collect = (ref: z.infer<typeof capabilitySecretRefSchema>) => {
    if (ref.source === "rookery-secret") keys.add(ref.key);
  };
  if (server.transport === "stdio") Object.values(server.secretEnv ?? {}).forEach(collect);
  else {
    Object.values(server.secretHeaders ?? {}).forEach(collect);
    if (server.auth) collect(server.auth.bearerToken);
  }
  return keys;
}

const capabilityMcpPackCreateInputSchema = z.object({
  id: capabilityMcpIdSchema,
  displayName: z.string().trim().min(1).max(80),
  version: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500),
  repoId: capabilityIdSchema,
  agents: z.array(z.enum(["master", "worker"])).min(1).max(2),
  mcpServers: z.array(capabilityMcpServerSchema).min(1).max(1_000),
  secretValues: capabilitySecretValuesSchema.optional(),
}).strict().superRefine((input, context) => {
  const normalizedIds = new Map<string, string>();
  const declaredSecretKeys = new Set<string>();
  const declareSecret = (ref: z.infer<typeof capabilitySecretRefSchema>) => {
    if (ref.source === "rookery-secret") declaredSecretKeys.add(ref.key);
  };

  for (const [index, server] of input.mcpServers.entries()) {
    const normalizedId = server.id.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    const previous = normalizedIds.get(normalizedId);
    if (previous) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mcpServers", index, "id"],
        message: `MCP server id collides with ${previous} after provider normalization`,
      });
    } else {
      normalizedIds.set(normalizedId, server.id);
    }

    if (server.transport === "stdio") {
      Object.values(server.secretEnv ?? {}).forEach(declareSecret);
    } else {
      Object.values(server.secretHeaders ?? {}).forEach(declareSecret);
      if (server.auth) declareSecret(server.auth.bearerToken);
    }
  }

  for (const secretKey of Object.keys(input.secretValues ?? {})) {
    if (!declaredSecretKeys.has(secretKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["secretValues", secretKey],
        message: "secret value must have a declared rookery-secret reference",
      });
    }
  }
});

const capabilityMcpCreateInputSchema = z.object({
  id: capabilityMcpIdSchema,
  displayName: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500),
  mcpServer: capabilityMcpServerSchema,
  secretValues: capabilitySecretValuesSchema.optional(),
}).strict().superRefine((input, context) => {
  const declared = declaredMcpSecretKeys(input.mcpServer);
  for (const secretKey of Object.keys(input.secretValues ?? {})) {
    if (!declared.has(secretKey)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["secretValues", secretKey],
        message: "secret value must have a declared rookery-secret reference",
      });
    }
  }
});

const capabilitySkillCreateInputSchema = z.object({
  id: capabilityMcpIdSchema,
  displayName: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500),
  sourcePath: z.string().trim().min(1).max(16_384),
}).strict();

const capabilityQuickBindingInputSchema = z.object({
  packInstanceId: capabilityIdSchema,
  scopeKind: z.enum(["rookery", "repo-local"]),
  scopeRef: z.string(),
  mode: z.enum(["inherit", "enabled", "disabled"]),
  agents: z.array(z.enum(["master", "worker"])).max(2),
}).strict().superRefine((input, context) => {
  if (input.scopeKind === "rookery" && input.scopeRef !== "") {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["scopeRef"], message: "rookery scopeRef must be empty" });
  }
  if (input.scopeKind === "repo-local" && !input.scopeRef.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["scopeRef"], message: "repo-local scopeRef must not be empty" });
  }
  if (input.mode !== "inherit" && input.agents.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["agents"], message: "explicit quick binding requires an agent" });
  }
});

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

const clientMessageBaseSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("session.create"), cwd: z.string().optional(), provider: z.enum(["claude", "codex"]).optional(), reqId: z.string().optional() }),
  // provider absent = same-provider native fork (backward compatible). provider set & different = cross-provider
  // handoff (docs/2026-07-08-cross-provider-fork-design.md). Master model/effort are a client-side per-session
  // override applied after the fork (no session column), so they are not carried here.
  z.object({ type: z.literal("session.fork"), sessionId: z.string(), reqId: z.string().optional(), provider: z.enum(["claude", "codex"]).optional() }),
  z.object({ type: z.literal("session.open"), key: z.string(), cwd: z.string().optional(), provider: z.enum(["claude", "codex"]).optional(), reqId: z.string().optional() }),
  z.object({ type: z.literal("session.attach"), sessionId: z.string() }),
  // model/effort/permissionMode: per-session UI overrides (independent of the default settings). If unspecified, fall back to the global defaults (permissionMode is bypassPermissions).
  z.object({ type: z.literal("session.send"), sessionId: z.string(), text: z.string(), model: z.string().optional(), effort: z.string().optional(), permissionMode: z.enum(["default", "acceptEdits", "bypassPermissions", "plan"]).optional(), clientMsgId: z.string().optional(), reqId: z.string().optional() }),
  z.object({ type: z.literal("session.stop"), sessionId: z.string(), reqId: z.string().optional() }),
  // Ephemeral read-only conversation forked from a master/worker provider session. It reuses the
  // source cwd (including a worker's live worktree) but never creates a session/worker/worktree row.
  z.object({ type: z.literal("side.start"), sourceKind: z.enum(["master", "worker"]), sourceId: z.string(), text: z.string().trim().min(1), model: z.string().optional(), effort: effortField, reqId: z.string() }),
  z.object({ type: z.literal("side.send"), sideId: z.string(), text: z.string().trim().min(1), reqId: z.string().optional() }),
  z.object({ type: z.literal("side.stop"), sideId: z.string(), reqId: z.string().optional() }),
  z.object({ type: z.literal("side.close"), sideId: z.string(), reqId: z.string().optional() }),
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
  z.object({ type: z.literal("workflow.list"), reqId: z.string(), workerId: z.string() }),
  z.object({ type: z.literal("workflow.agent.history"), reqId: z.string(), workerId: z.string(), taskId: z.string(), agentId: z.string() }),
  z.object({ type: z.literal("worker.send"), id: z.string(), text: z.string(), clientMsgId: z.string().optional(), reqId: z.string().optional() }),
  // Live-change the model of a running worker (query.setModel).
  z.object({ type: z.literal("worker.setModel"), id: z.string(), model: z.string(), reqId: z.string().optional() }),
  // Live-change the permission mode of a running worker (query.setPermissionMode). Only bypassPermissions/plan (no default/acceptEdits).
  z.object({ type: z.literal("worker.setPermissionMode"), id: z.string(), permissionMode: z.enum(["bypassPermissions", "plan"]), reqId: z.string().optional() }),
  // Interrupt the worker's current turn (query.interrupt) — keeps the session alive, further instructions possible. The worker-side counterpart of the master's session.stop.
  z.object({ type: z.literal("worker.interrupt"), id: z.string(), reqId: z.string().optional() }),
  z.object({ type: z.literal("worker.checkpoints"), reqId: z.string(), id: z.string() }),
  z.object({ type: z.literal("worker.restore"), reqId: z.string(), id: z.string(), seq: z.number() }),
  // provider set & different from the source = cross-provider handoff; workers persist model/effort (columns),
  // so those ride along here (unlike session.fork). Absent provider = same-provider native fork.
  z.object({ type: z.literal("worker.fork"), reqId: z.string(), id: z.string(), provider: z.enum(["claude", "codex"]).optional(), model: z.string().optional(), effort: z.string().optional() }),
  z.object({ type: z.literal("fleet.spawn"), reqId: z.string(), repo: z.string(), task: z.string().optional(), label: z.string().optional(), model: z.string().optional(), effort: z.string().optional(), permissionMode: z.enum(["bypassPermissions", "plan"]).optional(), base: z.string().optional(), ticketKey: z.string().optional(), ticketUrl: z.string().optional(), provider: z.enum(["claude", "codex"]).optional(), costBudgetUsd: z.number().positive().nullable().optional() }),
  // Structured slash actions/skills. Existing targets are authoritative; cwd/provider are cold-preview hints only.
  z.object({ type: z.literal("commands.list"), reqId: z.string(), cwd: z.string().optional(), sessionId: z.string().optional(), workerId: z.string().optional(), provider: z.enum(["claude", "codex"]).optional() }),
  z.object({
    type: z.literal("capabilities.snapshot"),
    reqId: z.string(),
    target: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("session"), id: capabilityIdSchema }).strict(),
      z.object({ kind: z.literal("worker"), id: capabilityIdSchema }).strict(),
      z.object({
        kind: z.literal("rookery"),
        provider: z.enum(["claude", "codex"]),
        agent: z.enum(["master", "worker"]),
      }).strict(),
      z.object({
        kind: z.literal("repo"),
        id: capabilityIdSchema,
        provider: z.enum(["claude", "codex"]),
        agent: z.enum(["master", "worker"]),
      }).strict(),
    ]),
  }),
  z.object({ type: z.literal("capabilities.library"), reqId: capabilityIdSchema }),
  z.object({
    type: z.literal("capabilities.mcpPack.create"),
    reqId: capabilityIdSchema,
    input: capabilityMcpPackCreateInputSchema,
  }).strict(),
  z.object({ type: z.literal("capabilities.mcp.create"), reqId: capabilityIdSchema, input: capabilityMcpCreateInputSchema }).strict(),
  z.object({ type: z.literal("capabilities.skill.create"), reqId: capabilityIdSchema, input: capabilitySkillCreateInputSchema }).strict(),
  z.object({ type: z.literal("capabilities.pack.add"), reqId: capabilityIdSchema, path: z.string().trim().min(1) }),
  z.object({ type: z.literal("capabilities.pack.remove"), reqId: capabilityIdSchema, instanceId: capabilityIdSchema }),
  z.object({ type: z.literal("capabilities.binding.set"), reqId: capabilityIdSchema, id: capabilityIdSchema, binding: capabilityBindingInputSchema }),
  z.object({ type: z.literal("capabilities.binding.quickSet"), reqId: capabilityIdSchema, input: capabilityQuickBindingInputSchema }).strict(),
  z.object({ type: z.literal("capabilities.binding.delete"), reqId: capabilityIdSchema, id: capabilityIdSchema }),
  z.object({
    type: z.literal("capabilities.trust.set"),
    reqId: capabilityIdSchema,
    instanceId: capabilityIdSchema,
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    trusted: z.boolean(),
  }),
  z.object({
    type: z.literal("capabilities.secret.set"),
    reqId: capabilityIdSchema,
    instanceId: capabilityIdSchema,
    key: capabilityIdSchema,
    value: z.string().refine((value) => value.trim().length > 0, "secret value must not be empty"),
  }),
  z.object({ type: z.literal("capabilities.secret.delete"), reqId: capabilityIdSchema, instanceId: capabilityIdSchema, key: capabilityIdSchema }),
  z.object({ type: z.literal("capabilities.refresh"), reqId: capabilityIdSchema, instanceId: capabilityIdSchema.optional() }),
  z.object({ type: z.literal("capabilities.worker.reload"), reqId: capabilityIdSchema, workerId: capabilityIdSchema, whenIdle: z.boolean().optional() }),
  z.object({ type: z.literal("usage.get"), reqId: z.string() }),
  z.object({ type: z.literal("models.list"), reqId: z.string() }),
  z.object({ type: z.literal("codex.models.list"), reqId: z.string() }),
  z.object({ type: z.literal("codex.authStatus"), reqId: z.string() }),
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
      mcpExposure: z.string().nullable().optional(), // External MCP exposure tier "off"/"readonly"/"full" (fail-closed default off). Echoed.
      slackBotToken: z.string().nullable().optional(), // write-only secret. Not echoed.
      slackAppToken: z.string().nullable().optional(), // write-only secret. Not echoed.
    }),
  }),
  z.object({ type: z.literal("slack.set"), enabled: z.boolean(), reqId: z.string().optional() }),
  // External MCP server (rookery-as-MCP): fetch current exposure/URL, or rotate the shared token.
  // The exposure tier itself (mcpExposure) rides settings.get/settings.set; these carry the computed URL.
  z.object({ type: z.literal("mcp.status"), reqId: z.string() }),
  z.object({ type: z.literal("mcp.regenerate_token"), reqId: z.string() }),
  z.object({ type: z.literal("automation.list"), reqId: z.string() }),
  z.object({ type: z.literal("automation.create"), reqId: z.string(), automation: automationInputSchema }),
  z.object({ type: z.literal("automation.update"), reqId: z.string(), id: z.string(), patch: automationInputSchema }),
  z.object({ type: z.literal("automation.delete"), reqId: z.string(), id: z.string() }),
  z.object({
    type: z.literal("automation.run"), reqId: z.string(), id: z.string(),
    vars: z.object({ message: z.string(), channel: z.string(), user: z.string(), ts: z.string(), threadTs: z.string(), team: z.string(), workerId: z.string(), repo: z.string(), branch: z.string(), status: z.string(), label: z.string(), tail: z.string() }).partial().optional(),
  }),
  z.object({ type: z.literal("automation.set_enabled"), reqId: z.string(), id: z.string(), enabled: z.boolean() }),
  // Best-effort Slack channel/user id → display name resolution for automation rule cards (audit #51). Never blocks
  // automation.list; on any failure or a disconnected/unconfigured Slack adapter, ids are simply omitted from the result.
  z.object({ type: z.literal("automation.resolveSlackRefs"), reqId: z.string(), channels: z.array(z.string()).optional(), users: z.array(z.string()).optional() }),
]);

export const clientMessageSchema = clientMessageBaseSchema.superRefine((message, ctx) => {
  if (message.type === "commands.list" && message.sessionId && message.workerId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "commands.list accepts only one target",
      path: ["sessionId"],
    });
  }
});

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

// Codex backend auth-readiness — structurally identical to core/codex-auth-provider.ts's CodexAuthStatus,
// re-declared here (not imported) for the same transport-agnostic reason as CodexModelInfo above.
export interface CodexAuthStatus {
  method: "api-key" | "chatgpt" | "bedrock" | "other" | "none";
  ready: boolean;
  hint: string | null;
}

export type ServerMessage =
  | { type: "session.created"; sessionId: string; cwd: string; reqId?: string }
  | { type: "side.started"; sideId: string; reqId: string }
  | { type: "session.list.result"; sessions: Array<{ id: string; cwd: string; status: string; lastActivity: string; origin: string; originRef: string | null; label: string | null; archived: boolean; pinned: boolean; provider?: string }>; reqId?: string }
  | { type: "worker.list.result"; sessionId: string; reqId?: string; workers: WorkerRow[] }
  | { type: "event"; event: CoreEvent }
  | { type: "error"; message: string; reqId?: string }
  | { type: "fleet.list.result"; reqId: string; fleet: Array<WorkerRow & { archived: boolean }> }
  | { type: "fleet.diff.result"; reqId: string; id: string; diff: string }
  | { type: "fleet.ack"; reqId: string; action: string; id: string }
  | { type: "repos.list.result"; reqId: string; repos: Array<{ id: string; name: string; path: string; description: string; base: string | null }> }
  | { type: "repo.branches.result"; reqId: string; branches: string[] }
  | { type: "source.fetch.result"; reqId: string; item: { title: string; body: string } | null }
  | { type: "source.search.result"; reqId: string; items: SourceItem[] }
  | ({ type: "integrations.status.result"; reqId: string } & IntegrationsStatus)
  | ({ type: "auth.status.result"; reqId: string } & AuthStatus)
  | { type: "repos.ack"; reqId: string; action: string; name: string }
  | { type: "session.history.result"; reqId: string; sessionId: string; events: Array<{ seq: number; type: string; payload: unknown; createdAt: string }> }
  | { type: "worker.history.result"; reqId: string; id: string; events: Array<{ seq: number; type: string; payload: unknown; createdAt: string }> }
  | { type: "workflow.list.result"; reqId: string; workerId: string; runs: WorkflowRunSnapshot[] }
  | { type: "workflow.agent.history.result"; reqId: string; workerId: string; taskId: string; agentId: string; events: WorkflowAgentHistoryEntry[] }
  | { type: "worker.checkpoints.result"; reqId: string; id: string; checkpoints: Array<{ seq: number; sha: string; createdAt: string }> }
  | { type: "fleet.spawn.result"; reqId: string; id: string }
  | { type: "usage.result"; reqId: string; usage: UsageSnapshot }
  | { type: "models.result"; reqId: string; models: Array<{ id: string; displayName: string }> }
  | { type: "codex.models.result"; reqId: string; models: CodexModelInfo[] | null }
  | { type: "codex.authStatus.result"; reqId: string; status: CodexAuthStatus | null }
  | { type: "commands.result"; reqId: string; commands: CommandCandidate[] }
  | { type: "capabilities.snapshot.result"; reqId: string; snapshot: CapabilitySnapshot }
  | { type: "capabilities.library.result"; reqId: string; library: CapabilityLibrarySnapshot }
  | ({ type: "capabilities.mcpPack.result"; reqId: string } & CapabilityMcpPackCreateResult)
  | ({ type: "capabilities.catalog.create.result"; reqId: string } & CapabilityCatalogCreateResult)
  | { type: "capabilities.pack.result"; reqId: string; pack: CapabilityLibraryEntry | null }
  | { type: "capabilities.binding.result"; reqId: string; binding: CapabilityBinding | null }
  | { type: "capabilities.binding.quickSet.result"; reqId: string; binding: CapabilityBinding | null }
  | { type: "capabilities.secret.result"; reqId: string; instanceId: string; secret: CapabilitySecretStatus }
  | { type: "capabilities.refresh.result"; reqId: string; library: CapabilityLibrarySnapshot }
  | { type: "capabilities.worker.reload.result"; reqId: string; workerId: string; mode: "reloading" | "scheduled" | "next-start" }
  | { type: "settings.result"; reqId: string; settings: SettingsValues }
  | { type: "mcp.status.result"; reqId: string; scope: "off" | "readonly" | "full"; url: string | null }
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
  "side.start": Extract<ServerMessage, { type: "side.started" }>;
  "side.send": Extract<ServerMessage, { type: "fleet.ack" }>;
  "side.stop": Extract<ServerMessage, { type: "fleet.ack" }>;
  "side.close": Extract<ServerMessage, { type: "fleet.ack" }>;
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
  "workflow.list": Extract<ServerMessage, { type: "workflow.list.result" }>;
  "workflow.agent.history": Extract<ServerMessage, { type: "workflow.agent.history.result" }>;
  "worker.checkpoints": Extract<ServerMessage, { type: "worker.checkpoints.result" }>;
  "usage.get": Extract<ServerMessage, { type: "usage.result" }>;
  "models.list": Extract<ServerMessage, { type: "models.result" }>;
  "codex.models.list": Extract<ServerMessage, { type: "codex.models.result" }>;
  "codex.authStatus": Extract<ServerMessage, { type: "codex.authStatus.result" }>;
  "commands.list": Extract<ServerMessage, { type: "commands.result" }>;
  "capabilities.snapshot": Extract<ServerMessage, { type: "capabilities.snapshot.result" }>;
  "capabilities.library": Extract<ServerMessage, { type: "capabilities.library.result" }>;
  "capabilities.mcpPack.create": Extract<ServerMessage, { type: "capabilities.mcpPack.result" }>;
  "capabilities.mcp.create": Extract<ServerMessage, { type: "capabilities.catalog.create.result" }>;
  "capabilities.skill.create": Extract<ServerMessage, { type: "capabilities.catalog.create.result" }>;
  "capabilities.pack.add": Extract<ServerMessage, { type: "capabilities.pack.result" }>;
  "capabilities.pack.remove": Extract<ServerMessage, { type: "capabilities.pack.result" }>;
  "capabilities.binding.set": Extract<ServerMessage, { type: "capabilities.binding.result" }>;
  "capabilities.binding.quickSet": Extract<ServerMessage, { type: "capabilities.binding.quickSet.result" }>;
  "capabilities.binding.delete": Extract<ServerMessage, { type: "capabilities.binding.result" }>;
  "capabilities.trust.set": Extract<ServerMessage, { type: "capabilities.pack.result" }>;
  "capabilities.secret.set": Extract<ServerMessage, { type: "capabilities.secret.result" }>;
  "capabilities.secret.delete": Extract<ServerMessage, { type: "capabilities.secret.result" }>;
  "capabilities.refresh": Extract<ServerMessage, { type: "capabilities.refresh.result" }>;
  "capabilities.worker.reload": Extract<ServerMessage, { type: "capabilities.worker.reload.result" }>;
  "settings.get": Extract<ServerMessage, { type: "settings.result" }>;
  "settings.set": Extract<ServerMessage, { type: "settings.result" }>;
  "mcp.status": Extract<ServerMessage, { type: "mcp.status.result" }>;
  "mcp.regenerate_token": Extract<ServerMessage, { type: "mcp.status.result" }>;
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
