import type { PermissionResult, CanUseTool } from "@anthropic-ai/claude-agent-sdk";
import type { EventBus, InteractionQuestion } from "./events.js";
import { t, DEFAULT_LOCALE } from "./i18n.js";

interface Pending {
  sessionId: string;
  kind: "approve" | "ask";
  questions?: InteractionQuestion[];
  resolve: (r: PermissionResult) => void;
}

// Response sent by the desktop (WS client): approvals carry decision, AskUserQuestion carries answers (question → selected label).
export interface InteractionResponse {
  decision?: "allow" | "deny";
  answers?: Record<string, string | string[]>;
}

// Registry that surfaces the master's canUseTool (approve/AskUserQuestion) via the EventBus and resolves it with the respond that comes back over WS.
// Slack uses its own bridge (SlackInteractionBridge); other (desktop/UI) sessions use this. core is transport-agnostic:
// it only emits the interaction.request event, and the daemon Connection receives the WS respond and calls respond().
export class InteractionRegistry {
  private readonly pending = new Map<string, Pending>(); // requestId(=toolUseID) -> pending
  constructor(private readonly bus: EventBus) {}

  // Session-bound canUseTool. SessionManager.makeCanUseTool injects it into non-Slack sessions.
  canUseToolFor(sessionId: string): CanUseTool {
    return (toolName, input, opts) =>
      this.request(sessionId, toolName, input as Record<string, unknown>, { toolUseID: opts.toolUseID, signal: opts.signal });
  }

  request(
    sessionId: string,
    toolName: string,
    input: Record<string, unknown>,
    opts: { toolUseID: string; signal?: AbortSignal },
  ): Promise<PermissionResult> {
    const requestId = opts.toolUseID;
    const isAsk = toolName === "AskUserQuestion" && Array.isArray((input as { questions?: unknown }).questions);
    const questions = isAsk ? (input as { questions: InteractionQuestion[] }).questions : undefined;
    return new Promise<PermissionResult>((resolve) => {
      this.pending.set(requestId, { sessionId, kind: isAsk ? "ask" : "approve", questions, resolve });
      this.armAbort(requestId, opts.signal, resolve);
      this.bus.emit(
        isAsk
          ? { type: "interaction.request", sessionId, requestId, kind: "ask", questions }
          : { type: "interaction.request", sessionId, requestId, kind: "approve", toolName, inputText: safeJson(input) },
      );
    });
  }

  // Called by Connection via WS interaction.respond. Unknown id is a no-op (ok:false).
  respond(requestId: string, res: InteractionResponse): { ok: boolean } {
    const p = this.pending.get(requestId);
    if (!p) return { ok: false };
    this.pending.delete(requestId);
    let summary: string;
    if (p.kind === "approve") {
      const allow = res.decision === "allow";
      p.resolve(allow ? { behavior: "allow" } : { behavior: "deny", message: t(DEFAULT_LOCALE, "interaction.denied") });
      summary = allow ? t(DEFAULT_LOCALE, "interaction.approved") : t(DEFAULT_LOCALE, "interaction.rejected");
    } else {
      const answers = res.answers ?? {};
      p.resolve({ behavior: "allow", updatedInput: { questions: p.questions, answers } });
      const body = Object.entries(answers).map(([k, v]) => `${k} → ${Array.isArray(v) ? v.join(", ") : v}`).join("\n");
      summary = t(DEFAULT_LOCALE, "interaction.answered", { summary: body });
    }
    this.bus.emit({ type: "interaction.resolved", sessionId: p.sessionId, requestId, summary });
    return { ok: true };
  }

  // Turn cancellation (AbortSignal) → if still pending, close it out with deny (prevents a permanent hang).
  private armAbort(requestId: string, signal: AbortSignal | undefined, resolve: (r: PermissionResult) => void): void {
    if (!signal) return;
    const onAbort = () => { if (this.pending.delete(requestId)) resolve({ behavior: "deny", message: t(DEFAULT_LOCALE, "interaction.cancelled") }); };
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
  }
}

function safeJson(v: unknown): string {
  try { const s = JSON.stringify(v); return s.length <= 500 ? s : s.slice(0, 499) + "…"; } catch { return ""; }
}
