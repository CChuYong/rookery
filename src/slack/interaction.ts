import type { PermissionResult, CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { ThreadTarget } from "./types.js";
import { t, type Locale } from "../core/i18n.js";

// A single question from AskUserQuestion input.
interface Question {
  question: string;
  header?: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
}

type Pending =
  | { kind: "approve"; resolve: (r: PermissionResult) => void }
  | { kind: "ask"; questions: Question[]; answers: Record<string, string>; resolve: (r: PermissionResult) => void };

// Post a single message with blocks to a thread (injected for tests). In practice a wrapper over Slack chat.postMessage.
export type PostBlocks = (target: ThreadTarget, msg: { text: string; blocks: unknown[] }) => Promise<unknown>;

const ACTION_PREFIX = "rk_int"; // Bolt catches actions with this prefix and forwards them to handleAction.
export const INTERACTION_ACTION_RE = /^rk_int:/;

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

// Session externalKey ("slack:team:channel:threadTs") → ThreadTarget. Returns null if not a slack thread.
export function parseSlackThreadKey(key: string | null): ThreadTarget | null {
  if (!key?.startsWith("slack:")) return null;
  const parts = key.split(":");
  if (parts.length < 4) return null;
  const [, team, channel, threadTs] = parts;
  if (!team || !channel || !threadTs) return null;
  return { channel, threadTs, team };
}

// For a slack session, build a canUseTool that routes to that thread (daemon → SessionManager.makeCanUseTool).
// If the bridge is down (not connected), don't block — pass through (allow): a dormant/safe default.
export function makeSlackCanUseTool(externalKey: string | null, getBridge: () => SlackInteractionBridge | null): CanUseTool | undefined {
  const target = parseSlackThreadKey(externalKey);
  if (!target) return undefined;
  return async (toolName, input, opts) => {
    const bridge = getBridge();
    if (!bridge) return { behavior: "allow" };
    return bridge.prompt(target, toolName, input, { toolUseID: opts.toolUseID, signal: opts.signal });
  };
}

// Bridge that takes the master's canUseTool (approval / AskUserQuestion) via Slack buttons/selects and returns the answer as a PermissionResult.
// core knows nothing about this; the daemon routes session → thread and wires prompt() up as canUseTool.
export class SlackInteractionBridge {
  private readonly pending = new Map<string, Pending>(); // toolUseID -> pending
  constructor(private readonly post: PostBlocks, private readonly getLocale: () => Locale = () => "ko") {}

  async prompt(
    target: ThreadTarget,
    toolName: string,
    input: Record<string, unknown>,
    opts: { toolUseID: string; signal?: AbortSignal },
  ): Promise<PermissionResult> {
    const id = opts.toolUseID;
    if (toolName === "AskUserQuestion" && Array.isArray((input as { questions?: unknown }).questions)) {
      const questions = (input as { questions: Question[] }).questions;
      return new Promise<PermissionResult>((resolve) => {
        this.pending.set(id, { kind: "ask", questions, answers: {}, resolve });
        this.armAbort(id, opts.signal, resolve);
        void this.post(target, { text: t(this.getLocale(), "slack.askQuestion"), blocks: this.askBlocks(id, questions) });
      });
    }
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(id, { kind: "approve", resolve });
      this.armAbort(id, opts.signal, resolve);
      void this.post(target, { text: t(this.getLocale(), "slack.approveNeeded", { tool: toolName }), blocks: this.approveBlocks(id, toolName, input) });
    });
  }

  // The Bolt action handler calls this with the clicked button's value (a JSON string).
  // Returns: { done:true, summary } if this click ended the interaction (the caller updates the message with that summary → removing the buttons).
  //          { done:false } if questions remain to be answered, undefined if there's no match.
  handleAction(value: string): { done: boolean; summary: string } | undefined {
    let v: { t?: string; d?: "allow" | "deny"; q?: number; a?: string };
    try { v = JSON.parse(value); } catch { return undefined; }
    if (!v.t) return undefined;
    const p = this.pending.get(v.t);
    if (!p) return undefined; // unknown / already resolved → ignore
    if (p.kind === "approve" && v.d) {
      this.pending.delete(v.t);
      const allow = v.d === "allow";
      p.resolve(allow ? { behavior: "allow" } : { behavior: "deny", message: t(this.getLocale(), "interaction.denied") });
      return { done: true, summary: allow ? t(this.getLocale(), "interaction.approved") : t(this.getLocale(), "interaction.rejected") };
    }
    if (p.kind === "ask" && typeof v.q === "number" && v.a !== undefined) {
      const q = p.questions[v.q];
      if (q) p.answers[q.question] = v.a;
      // Once every question has an answer, resolve all at once.
      if (p.questions.every((qq) => qq.question in p.answers)) {
        this.pending.delete(v.t);
        p.resolve({ behavior: "allow", updatedInput: { questions: p.questions, answers: p.answers } });
        const summary = Object.entries(p.answers).map(([k, val]) => `*${k}* → ${val}`).join("\n");
        return { done: true, summary: t(this.getLocale(), "interaction.answered", { summary }) };
      }
      return { done: false, summary: "" };
    }
    return undefined;
  }

  // Turn cancellation (AbortSignal) → if still pending, close it out with deny.
  private armAbort(id: string, signal: AbortSignal | undefined, resolve: (r: PermissionResult) => void): void {
    if (!signal) return;
    const onAbort = () => { if (this.pending.delete(id)) resolve({ behavior: "deny", message: t(this.getLocale(), "interaction.cancelled") }); };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
  }

  private approveBlocks(id: string, toolName: string, input: Record<string, unknown>): unknown[] {
    let detail = "";
    try { detail = truncate(JSON.stringify(input), 300); } catch { detail = ""; }
    return [
      { type: "section", text: { type: "mrkdwn", text: t(this.getLocale(), "slack.approvePrompt", { tool: toolName, detail: detail ? `\n\`${detail}\`` : "" }) } },
      { type: "actions", elements: [
        { type: "button", action_id: `${ACTION_PREFIX}:${id}:ok`, style: "primary", text: { type: "plain_text", text: t(this.getLocale(), "slack.approveBtn") }, value: JSON.stringify({ t: id, d: "allow" }) },
        { type: "button", action_id: `${ACTION_PREFIX}:${id}:no`, style: "danger", text: { type: "plain_text", text: t(this.getLocale(), "slack.denyBtn") }, value: JSON.stringify({ t: id, d: "deny" }) },
      ] },
    ];
  }

  private askBlocks(id: string, questions: Question[]): unknown[] {
    const blocks: unknown[] = [];
    questions.forEach((q, qi) => {
      blocks.push({ type: "section", text: { type: "mrkdwn", text: `${q.header ? `*${q.header}* · ` : ""}${q.question}` } });
      // A Slack actions block holds at most 5 elements → buttons for up to 5 options (the rest are omitted in v1).
      blocks.push({ type: "actions", elements: q.options.slice(0, 5).map((o, oi) => ({
        type: "button",
        action_id: `${ACTION_PREFIX}:${id}:${qi}:${oi}`,
        text: { type: "plain_text", text: truncate(o.label, 70) },
        value: JSON.stringify({ t: id, q: qi, a: o.label }),
      })) });
    });
    return blocks;
  }
}
