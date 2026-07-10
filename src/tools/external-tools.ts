import { tool } from "@anthropic-ai/claude-agent-sdk";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { FleetOrchestrator } from "../core/fleet-orchestrator.js";
import type { Repositories } from "../persistence/repositories.js";
import type { SessionManager } from "../core/session-manager.js";
import { EXTERNAL_FLEET_SESSION_KEY } from "../core/session-manager.js";
import { isSafeGitRef } from "../core/git-ref.js";
import { spawnWorkerImpl, formatTranscript } from "./fleet-tools.js";

// Byte cap on transcript output returned to an external client (mirrors fleet-tools' own cap).
const TRANSCRIPT_MAX_BYTES = 256 * 1024;

// Tool names exposed to external MCP clients, split by scope tier. The bridge registers tool()
// objects by their bare name (no server prefix), so these are the plain names — unlike the master's
// `mcp__<server>__<name>` allowlist entries, there is no allowedTools gate here: the scope tier itself
// IS the gate (readonly omits every mutating tool from the registered set).
export const EXTERNAL_READONLY_TOOL_NAMES = ["list_workers", "get_worker_status", "view_worker_transcript", "view_worker_diff", "list_repos"] as const;
export const EXTERNAL_FULL_TOOL_NAMES = [...EXTERNAL_READONLY_TOOL_NAMES, "spawn_worker", "send_worker", "interrupt_worker", "stop_worker", "discard_worker"] as const;

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}
function errorText(t: string) {
  return { content: [{ type: "text" as const, text: t }], isError: true };
}
// v1 audit: one stderr line per external tool call (no args — avoids leaking task text to the daemon log).
function audit(name: string) {
  console.error(`[mcp-ext] tool=${name}`);
}

export interface ExternalToolsDeps {
  fleet: FleetOrchestrator;
  repos: Repositories;
  sessions: SessionManager;
}

// Tools exposed to EXTERNAL MCP clients (rookery-as-MCP). Same underlying fleet/repos operations as the
// master's fleet tools, but: descriptions are written for an outside caller, `notify` is dropped (it wakes
// the home master session, meaningless for the external:fleet container), and spawns are attributed to the
// hidden external:fleet home session so their workers appear in the normal fleet views. Structurally
// SdkMcpToolDefinition[] — the daemon casts to BridgeToolDef[] when registering (same as the codex path).
export function externalToolDefs(deps: ExternalToolsDeps, scope: "readonly" | "full"): SdkMcpToolDefinition<any>[] {
  const { fleet, repos, sessions } = deps;

  const list = tool(
    "list_workers",
    "List all workers in the rookery fleet (global). Each line shows id, status, agent backend, label, and branch.",
    { status: z.string().optional(), repo: z.string().optional(), provider: z.enum(["claude", "codex"]).optional() },
    async (args) => {
      audit("list_workers");
      const repoPath = args.repo ? repos.getRepoByName(args.repo)?.path : undefined;
      const items = fleet.list({ status: args.status, repoPath }).filter((a) => !args.provider || a.provider === args.provider);
      const body = items.length === 0 ? "No workers." : items.map((a) => `${a.id} [${a.status}·${a.provider}] ${a.label} ${a.branch ?? ""}`.trim()).join("\n");
      return text(body);
    },
    { annotations: { readOnlyHint: true } },
  );

  const status = tool(
    "get_worker_status",
    "Status of one worker (with its agent backend).",
    { id: z.string() },
    async (args) => {
      audit("get_worker_status");
      try {
        return text(`${args.id}: ${fleet.status(args.id)} (${repos.getWorker(args.id)?.provider ?? "claude"})`);
      } catch (err) {
        return errorText(String(err));
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const transcript = tool(
    "view_worker_transcript",
    "View a worker's transcript (its conversation and tool activity).",
    { id: z.string(), sinceSeq: z.number().optional() },
    async (args) => {
      audit("view_worker_transcript");
      try {
        const t = fleet.transcript(args.id, args.sinceSeq);
        return text(formatTranscript(t, TRANSCRIPT_MAX_BYTES));
      } catch (err) {
        return errorText(String(err));
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const diff = tool(
    "view_worker_diff",
    "Show the git diff of a worker's worktree vs its base branch.",
    { id: z.string() },
    async (args) => {
      audit("view_worker_diff");
      try {
        const d = await fleet.diff(args.id);
        return text(d || "(no changes)");
      } catch (err) {
        return errorText(`diff failed: ${String(err)}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const listRepos = tool(
    "list_repos",
    "List the repos registered in rookery (name + domain description). Use a repo name with spawn_worker.",
    {},
    async () => {
      audit("list_repos");
      const rs = repos.listRepos();
      const body = rs.length === 0 ? "No repos registered." : rs.map((r) => `${r.name} — ${r.description}${r.base ? ` (base ${r.base})` : ""}`).join("\n");
      return text(body);
    },
    { annotations: { readOnlyHint: true } },
  );

  const readonly = [list, status, transcript, diff, listRepos];
  if (scope === "readonly") return readonly;

  const spawn = tool(
    "spawn_worker",
    "Spawn a worktree-isolated rookery worker to work on a task in a REGISTERED repo (by name). It runs autonomously in its own git worktree, then idles awaiting further instructions. Observe it (view_worker_transcript / get_worker_status / view_worker_diff), steer it (send_worker), and tell it to commit & open a PR itself when the work is ready. " +
      "Leave `model`/`effort` unset to use rookery's configured defaults. Pass `provider` only to force a specific backend (default claude).",
    {
      repo: z.string().describe("Registered repo name (see list_repos)."),
      task: z.string(),
      base: z.string().optional(),
      model: z.string().optional().describe("Override the worker model; omit to use the default."),
      effort: z.string().optional().describe("Override reasoning effort (low|medium|high|xhigh|max); omit to use the default."),
      provider: z.enum(["claude", "codex"]).optional().describe("Agent backend (default claude)."),
    },
    async (args) => {
      audit("spawn_worker");
      const repo = repos.getRepoByName(args.repo);
      if (!repo) return errorText(`unknown repo '${args.repo}'. Call list_repos to see registered repos.`);
      if (args.base !== undefined && !isSafeGitRef(args.base)) {
        return errorText(`invalid base ref '${args.base}'. Use a plain branch name, tag, or commit SHA (no spaces or leading '-').`);
      }
      // Resolve the hidden external:fleet home session lazily (per spawn), mirroring automation-action.ts.
      const home = sessions.getOrCreateByKey(EXTERNAL_FLEET_SESSION_KEY, repo.path);
      return spawnWorkerImpl(fleet, repos, home.id, args);
    },
  );

  const send = tool(
    "send_worker",
    "Send a follow-up instruction to a running or idle worker. It continues the same session in its worktree (full context preserved) — steer it, correct it, or ask it to commit/push and open its own PR. " +
      "Does NOT interrupt a mid-turn worker: the instruction is queued for the next turn boundary. To make it drop what it is doing, call interrupt_worker first.",
    { id: z.string(), text: z.string().describe("The instruction to send.") },
    async (args) => {
      audit("send_worker");
      try {
        fleet.send(args.id, args.text);
        return text(`Sent to ${args.id}.`);
      } catch (err) {
        return errorText(`send failed: ${String(err)}`);
      }
    },
  );

  const interrupt = tool(
    "interrupt_worker",
    "Abort a running worker's CURRENT turn while keeping its session alive (worktree and context preserved). Use it to stop in-progress work so you can redirect — typically followed by send_worker. A no-op if the worker is already idle.",
    { id: z.string() },
    async (args) => {
      audit("interrupt_worker");
      try {
        await fleet.interrupt(args.id);
        return text(`Interrupted ${args.id}. Its current turn was aborted; the session is idle — send_worker to give it a new instruction.`);
      } catch (err) {
        return errorText(`interrupt failed: ${String(err)}`);
      }
    },
  );

  const stop = tool(
    "stop_worker",
    "Stop a running worker (keeps its worktree). Terminal — the worker can't be sent to again.",
    { id: z.string() },
    async (args) => {
      audit("stop_worker");
      try {
        await fleet.stop(args.id);
        return text(`Stopped ${args.id}.`);
      } catch (err) {
        return errorText(String(err));
      }
    },
  );

  const discard = tool(
    "discard_worker",
    "Stop a worker and remove its worktree + branch (discards uncommitted work).",
    { id: z.string() },
    async (args) => {
      audit("discard_worker");
      try {
        await fleet.discard(args.id);
        return text(`Discarded ${args.id}.`);
      } catch (err) {
        return errorText(`discard failed: ${String(err)}`);
      }
    },
  );

  return [...readonly, spawn, send, interrupt, stop, discard];
}
