import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance, SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { FleetOrchestrator } from "../core/fleet-orchestrator.js";
import type { Repositories } from "../persistence/repositories.js";
import { isSafeGitRef } from "../core/git-ref.js";

// Byte cap on transcript output that gets re-injected into the master context (symmetric with view_subagent_diff). Row count is capped by listWorkerEvents.
const TRANSCRIPT_MAX_BYTES = 256 * 1024;

export const FLEET_SERVER_NAME = "fleet";
export const FLEET_TOOL_NAMES = [
  "mcp__fleet__spawn_worker",
  "mcp__fleet__send_worker",
  "mcp__fleet__interrupt_worker",
  "mcp__fleet__list_workers",
  "mcp__fleet__get_worker_status",
  "mcp__fleet__view_worker_transcript",
  "mcp__fleet__view_worker_diff",
  "mcp__fleet__stop_worker",
  "mcp__fleet__discard_worker",
] as const;

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}
function errorText(t: string) {
  return { content: [{ type: "text" as const, text: t }], isError: true };
}

// Format a worker transcript for re-injection into the master's context. CRITICAL: fill the byte budget from the NEWEST
// event backward (then restore chronological order) so an overflowing transcript surfaces the worker's CURRENT state,
// not ancient history — the reverse of a leading byte-truncation, and matching the newest-first fill in slack-thread-tools.
export function formatTranscript(events: Array<{ seq: number; type: string; payload: unknown }>, maxBytes: number): string {
  if (events.length === 0) return "No events.";
  const lines = events.map((e) => `#${e.seq} ${e.type}: ${JSON.stringify(e.payload)}`);
  const kept: string[] = [];
  let bytes = 0;
  for (let i = lines.length - 1; i >= 0; i--) {
    const b = Buffer.byteLength(lines[i]!, "utf8") + 1; // +1 ≈ newline
    if (kept.length > 0 && bytes + b > maxBytes) break; // always keep at least the newest event
    kept.push(lines[i]!);
    bytes += b;
  }
  kept.reverse();
  const dropped = lines.length - kept.length;
  return (dropped > 0 ? `…(${dropped} older event${dropped === 1 ? "" : "s"} truncated)\n` : "") + kept.join("\n");
}

// Extracted from the spawn_worker tool() handler so it's directly callable from tests (mirrors schedule-tools.ts's *Impl convention).
export async function spawnWorkerImpl(
  fleet: FleetOrchestrator,
  repos: Repositories,
  homeSessionId: string,
  args: { repo: string; task: string; base?: string; model?: string; effort?: string; provider?: "claude" | "codex"; notify?: boolean; costBudgetUsd?: number },
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }> {
  const repo = repos.getRepoByName(args.repo);
  if (!repo) return errorText(`unknown repo '${args.repo}'. Register it first or call list_repos.`);
  const base = args.base ?? repo.base ?? undefined;
  if (base !== undefined && !isSafeGitRef(base)) {
    return errorText(`invalid base ref '${base}'. Use a plain branch name, tag, or commit SHA (no spaces or leading '-').`);
  }
  try {
    // model/effort are only set when explicitly requested — otherwise undefined → fleet.spawn launches with the global defaults.
    const { id } = await fleet.spawn({ homeSessionId, repoPath: repo.path, label: repo.name, task: args.task, base, model: args.model, effort: args.effort, provider: args.provider, notify: args.notify, costBudgetUsd: args.costBudgetUsd });
    return text(`Spawned ${id} in '${repo.name}' (worktree branch rookery/${id}).${args.notify ? " You'll be notified when it finishes." : ""}`);
  } catch (err) {
    return errorText(`spawn failed: ${String(err)}`);
  }
}

// Raw tool defs (extracted so they can travel the provider-neutral port — see agent-backend.ts's
// ProviderToolDef / MasterTurnOptions.toolDefs). Claude wraps these with createSdkMcpServer below;
// the Codex adapter registers the same objects on the daemon MCP bridge (src/daemon/mcp-bridge.ts).
export function fleetToolDefs(
  fleet: FleetOrchestrator,
  repos: Repositories,
  homeSessionId: string,
): SdkMcpToolDefinition<any>[] {
  const spawn = tool(
    "spawn_worker",
    "Spawn a worktree-isolated worker to work on a task in a REGISTERED repo (by name). It runs autonomously, then idles awaiting further instructions. Observe it (view_worker_transcript / get_worker_status / view_worker_diff), steer it (send_worker), and tell it to commit & open a PR itself when the work is ready. " +
      "Leave `model` and `effort` UNSET so the worker uses the configured default — only pass them when the user has explicitly asked for a specific model or reasoning effort for this worker. " +
      "Pass `provider` only when the user explicitly wants this worker on a specific agent backend (default claude).",
    {
      repo: z.string().describe("Registered repo name (see list_repos)."),
      task: z.string(),
      base: z.string().optional(),
      model: z.string().optional().describe("Override the worker model ONLY when the user explicitly requested a specific model; otherwise omit to use the default."),
      effort: z.string().optional().describe("Override reasoning effort (low|medium|high|xhigh|max) ONLY when the user explicitly requested it; otherwise omit to use the default."),
      provider: z.enum(["claude", "codex"]).optional().describe("Agent backend for this worker (default claude). codex = OpenAI Codex via app-server."),
      notify: z.boolean().optional().describe("When true, you are notified once this worker finishes this dispatch (goes idle) or fails — your turn can end and you'll be woken with the result. One-shot: re-arm with send_worker notify:true."),
      costBudgetUsd: z.number().positive().optional().describe("Stop the worker once its cumulative cost reaches this many USD (runaway guard). Omit = unlimited."),
    },
    async (args) => spawnWorkerImpl(fleet, repos, homeSessionId, args),
  );

  const send = tool(
    "send_worker",
    "Send a follow-up instruction to a running or idle worker. It continues the same session in its worktree (full context preserved). Use this to steer, correct, ask it to commit/push and open its own PR, or to continue after it has gone idle. " +
      "Does NOT interrupt: if the worker is mid-turn, the instruction is queued and runs at the next turn boundary (it does not abort the work in progress). To make it drop what it is doing and act on your new instruction immediately, call interrupt_worker first, then send_worker.",
    { id: z.string(), text: z.string().describe("The instruction to send."), notify: z.boolean().optional().describe("When true, you are notified once the worker finishes this instruction (idle) or fails. One-shot.") },
    async (args) => {
      try {
        fleet.send(args.id, args.text);
        if (args.notify) fleet.armNotify(args.id);
        return text(`Sent to ${args.id}.${args.notify ? " You'll be notified when it finishes." : ""}`);
      } catch (err) {
        return errorText(`send failed: ${String(err)}`);
      }
    },
  );

  const interrupt = tool(
    "interrupt_worker",
    "Abort a running worker's CURRENT turn while keeping its session alive (worktree and full context preserved). Use this to stop work already in progress so you can redirect it — typically followed by send_worker with the new instruction. " +
      "Unlike stop_worker (terminal — the worker can't be sent to again) this leaves the worker idle and ready for follow-ups. A no-op if the worker is already idle.",
    { id: z.string() },
    async (args) => {
      try {
        await fleet.interrupt(args.id);
        return text(`Interrupted ${args.id}. Its current turn was aborted; the session is idle — send_worker to give it a new instruction.`);
      } catch (err) {
        return errorText(`interrupt failed: ${String(err)}`);
      }
    },
  );

  const list = tool(
    "list_workers",
    "List all workers in the fleet (global).",
    { status: z.string().optional(), repo: z.string().optional() },
    async (args) => {
      const repoPath = args.repo ? repos.getRepoByName(args.repo)?.path : undefined;
      const items = fleet.list({ status: args.status, repoPath });
      const body = items.length === 0 ? "No workers." : items.map((a) => `${a.id} [${a.status}] ${a.label} ${a.branch ?? ""}`.trim()).join("\n");
      return text(body);
    },
    { annotations: { readOnlyHint: true } },
  );

  const status = tool(
    "get_worker_status",
    "Status of one worker.",
    { id: z.string() },
    async (args) => {
      try {
        return text(`${args.id}: ${fleet.status(args.id)}`);
      } catch (err) {
        return errorText(String(err));
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const transcript = tool(
    "view_worker_transcript",
    "View a worker's transcript.",
    { id: z.string(), sinceSeq: z.number().optional() },
    async (args) => {
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
    "Show the git diff of a worker's worktree vs its base.",
    { id: z.string() },
    async (args) => {
      try {
        const d = await fleet.diff(args.id);
        return text(d || "(no changes)");
      } catch (err) {
        return errorText(`diff failed: ${String(err)}`);
      }
    },
    { annotations: { readOnlyHint: true } },
  );

  const stop = tool(
    "stop_worker",
    "Stop a running worker (keeps its worktree).",
    { id: z.string() },
    async (args) => {
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
    "Stop a worker and remove its worktree+branch (discards uncommitted work).",
    { id: z.string() },
    async (args) => {
      try {
        await fleet.discard(args.id);
        return text(`Discarded ${args.id}.`);
      } catch (err) {
        return errorText(`discard failed: ${String(err)}`);
      }
    },
  );

  return [spawn, send, interrupt, list, status, transcript, diff, stop, discard];
}

export function createFleetToolsServer(
  fleet: FleetOrchestrator,
  repos: Repositories,
  homeSessionId: string,
): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({ name: FLEET_SERVER_NAME, version: "0.0.1", tools: fleetToolDefs(fleet, repos, homeSessionId) });
}
