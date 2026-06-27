import { randomUUID } from "node:crypto";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Repositories, Automation } from "../persistence/repositories.js";

export const SCHEDULE_SERVER_NAME = "schedule";
export const SCHEDULE_TOOL_NAMES = [
  "mcp__schedule__schedule_wakeup",
  "mcp__schedule__schedule_list",
  "mcp__schedule__schedule_cancel",
] as const;

const MIN_DELAY = 60;
const MAX_DELAY = 3600;
const MAX_PENDING = 10; // cap on pending wakeups per session — fork-bomb prevention (lesson from #58235)

// Port injected by the daemon. core doesn't know about Scheduler; the daemon wires reconcile to scheduler.reconcile.
export interface ScheduleControl {
  repos: Pick<Repositories, "createAutomation" | "listAutomations" | "getAutomation" | "deleteAutomation" | "getSession">;
  reconcile: (id: string) => void;
  now: () => Date;
  idgen?: () => string;
}

type Result = { text: string; isError?: boolean };

// Pending one-shot wakeups targeting this session.
function pendingFor(c: ScheduleControl, sessionId: string): Automation[] {
  return c.repos.listAutomations().filter(
    (a) => a.trigger.kind === "once" && a.action.kind === "master" && a.action.targetSessionId === sessionId,
  );
}

export function wakeupImpl(c: ScheduleControl, sessionId: string, args: { delaySeconds: number; reason: string; prompt: string }): Result {
  const pending = pendingFor(c, sessionId);
  if (pending.length >= MAX_PENDING) {
    return { text: `Too many pending wakeups for this session (${pending.length}/${MAX_PENDING}). Cancel some with schedule_cancel first.`, isError: true };
  }
  const clampedDelaySeconds = Math.max(MIN_DELAY, Math.min(MAX_DELAY, Math.round(args.delaySeconds)));
  const wasClamped = args.delaySeconds < MIN_DELAY || args.delaySeconds > MAX_DELAY;
  const scheduledFor = c.now().getTime() + clampedDelaySeconds * 1000;
  const runAt = new Date(scheduledFor).toISOString();
  const id = (c.idgen ?? randomUUID)();
  const cwd = c.repos.getSession(sessionId)?.cwd ?? process.cwd();
  c.repos.createAutomation(id, {
    name: args.reason.slice(0, 120) || "wakeup",
    enabled: true,
    trigger: { kind: "once", runAt },
    action: { kind: "master", prompt: args.prompt, cwd, sessionMode: "reuse", targetSessionId: sessionId },
    model: null,
    effort: null,
  });
  c.reconcile(id);
  return { text: JSON.stringify({ id, scheduledFor, clampedDelaySeconds, wasClamped }) };
}

export function listImpl(c: ScheduleControl, sessionId: string): Result {
  const jobs = pendingFor(c, sessionId).map((a) => ({
    id: a.id,
    runAt: a.trigger.kind === "once" ? a.trigger.runAt : null,
    reason: a.name,
    prompt: a.action.kind === "master" ? a.action.prompt : "",
  }));
  return { text: JSON.stringify({ jobs }) };
}

export function cancelImpl(c: ScheduleControl, sessionId: string, id: string): Result {
  const a = c.repos.getAutomation(id);
  if (!a || a.trigger.kind !== "once" || a.action.kind !== "master" || a.action.targetSessionId !== sessionId) {
    return { text: `No pending wakeup '${id}' for this session.`, isError: true };
  }
  c.repos.deleteAutomation(id);
  return { text: JSON.stringify({ id }) };
}

const WAKEUP_DESC =
  "Schedule rookery to resume THIS conversation later by re-running `prompt` as a fresh master turn on your current session. The daemon's scheduler fires it — so this works even though your current turn ends. Use for self-paced check-backs, reminders, or polling external state the daemon can't notify you about. To be notified when a worker you spawned finishes, prefer spawn_worker/send_worker notify:true over a short wakeup poll.\n\n" +
  "## Picking delaySeconds\n" +
  "Your session resumes through the Anthropic prompt cache (~5-minute TTL), so:\n" +
  "- **60–270s**: cache stays warm — right for actively polling external state (a CI run, deploy, queue).\n" +
  "- **300–3600s**: pay a cache miss — right when there's no point checking sooner, or as a long fallback heartbeat.\n" +
  "- **Don't pick exactly 300s** (worst of both — a cache miss you don't amortize). Drop to 270s or commit to 1200s+.\n" +
  "- For idle ticks with no specific signal, default to **1200–1800s** (20–30 min).\n" +
  "The runtime clamps to [60, 3600], so you don't need to clamp yourself.\n\n" +
  "`reason`: one short, specific sentence — shown to the user in the scheduled list and telemetry ('watching CI run' beats 'waiting').\n" +
  "`prompt`: a FULLY SELF-CONTAINED instruction to run on wake — no 'as we discussed', no relative dates; it must stand alone even though it continues your session. To END the loop, simply don't call this again.";

const LIST_DESC = "List this session's pending one-shot wakeups (scheduled with schedule_wakeup) with their ids, fire times, and reasons.";
const CANCEL_DESC = "Cancel a pending wakeup by id (only wakeups you scheduled for this session). Use schedule_list to find ids.";

function toContent(r: Result) {
  return { content: [{ type: "text" as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
}

export function createScheduleToolsServer(c: ScheduleControl, sessionId: string): McpSdkServerConfigWithInstance {
  const wakeup = tool(
    "schedule_wakeup",
    WAKEUP_DESC,
    { delaySeconds: z.number(), reason: z.string(), prompt: z.string() },
    async (args) => toContent(wakeupImpl(c, sessionId, args)),
  );
  const list = tool("schedule_list", LIST_DESC, {}, async () => toContent(listImpl(c, sessionId)));
  const cancel = tool("schedule_cancel", CANCEL_DESC, { id: z.string() }, async (args) => toContent(cancelImpl(c, sessionId, args.id)));
  return createSdkMcpServer({ name: SCHEDULE_SERVER_NAME, version: "0.0.1", tools: [wakeup, list, cancel] });
}
