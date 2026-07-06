import type { CodexSpawn, CodexTransport } from "../../src/core/codex/codex-transport.js";

// One step of a scripted turn — what the fake server emits in response to turn/start.
export type CodexStep =
  | { kind: "agentDelta"; text: string }
  | { kind: "reasoningDelta"; text: string }
  | { kind: "agentMessage"; text: string; id?: string }
  | { kind: "command"; id: string; command: string; output?: string; failed?: boolean }
  | { kind: "fileChange"; id: string; failed?: boolean }
  | { kind: "tokenUsage"; last: { inputTokens: number; cachedInputTokens?: number }; total?: { inputTokens: number; cachedInputTokens?: number; outputTokens?: number }; contextWindow?: number }
  | { kind: "errorNote"; message: string }
  | { kind: "requestApproval"; id: string } // emits a server→client commandExecution approval request
  | { kind: "turnEnd"; status?: "completed" | "interrupted" | "failed"; durationMs?: number; errorMessage?: string }
  | { kind: "staleTurnEnd" }; // emits turn/completed for a DIFFERENT (stale) turn id — pins the activeTurnId correlation guard

export interface FakeCodexServerOpts {
  threadId?: string;
  failThreadStart?: boolean; // reject thread/start (spawn/handshake failure path)
  dieAfterTurns?: number;    // simulate process death after N completed turns
}

// Drives CodexClient exactly like fakeStreamingQuery drives ClaudeBackend: per turn/start, replays the
// responder's steps, emitting turn/completed only when a step ends the turn; a never-ending step list
// leaves the turn open (for interrupt/abort tests). Handles initialize/thread lifecycle with canned responses.
export function fakeCodexSpawn(
  responder: (text: string, turn: number) => CodexStep[],
  opts: FakeCodexServerOpts = {},
): {
  spawn: CodexSpawn;
  requests: Array<{ method: string; params: Record<string, unknown> }>;
  responses: Array<{ id: number | string; result: unknown }>;
} {
  const requests: Array<{ method: string; params: Record<string, unknown> }> = [];
  const responses: Array<{ id: number | string; result: unknown }> = [];
  const threadId = opts.threadId ?? "th-1";
  const spawn: CodexSpawn = () => {
    let lineCb: (l: string) => void = () => {};
    let exitCb: (i: { code: number | null; message?: string }) => void = () => {};
    let killed = false;
    let turnCount = 0;
    let currentTurnId: string | null = null; // the most recently turn/start-ed turn's id — turn/interrupt targets THIS, not a recomputed/advanced counter
    const send = (o: unknown) => { if (!killed) queueMicrotask(() => { if (!killed) lineCb(JSON.stringify(o)); }); };
    const transport: CodexTransport = {
      onLine: (cb) => { lineCb = cb; },
      onExit: (cb) => { exitCb = cb; },
      kill: () => { killed = true; },
      write: (line) => {
        const msg = JSON.parse(line) as {
          id?: number | string;
          method?: string;
          params?: Record<string, unknown>;
          result?: unknown;
        };
        if (!msg.method) {
          // client RESPONSE to a server request (e.g. an approval decision) — no method,
          // just id + result/error. Record it so approval-flow tests can observe it.
          if (msg.id !== undefined) responses.push({ id: msg.id, result: msg.result });
          return;
        }
        requests.push({ method: msg.method, params: msg.params ?? {} });
        if (msg.method === "initialize") { send({ id: msg.id, result: { userAgent: "fake" } }); return; }
        if (msg.method === "initialized") return;
        if (msg.method === "thread/start" || msg.method === "thread/resume" || msg.method === "thread/fork") {
          if (opts.failThreadStart) { send({ id: msg.id, error: { code: -32000, message: "no auth" } }); return; }
          const id = msg.method === "thread/fork" ? `${threadId}-fork` : threadId;
          send({ method: "thread/started", params: { thread: { id } } });
          send({ id: msg.id, result: { thread: { id }, model: "gpt-5.5" } });
          return;
        }
        if (msg.method === "turn/interrupt") {
          send({ id: msg.id, result: {} });
          send({ method: "turn/completed", params: { threadId, turn: { id: currentTurnId ?? `turn-${turnCount}`, status: "interrupted", durationMs: 5 } } });
          turnCount++; // the interrupted turn is now done — the next turn/start gets a fresh id
          return;
        }
        if (msg.method === "turn/start") {
          const turnId = `turn-${turnCount}`;
          currentTurnId = turnId;
          send({ id: msg.id, result: { turn: { id: turnId, status: "inProgress" } } });
          send({ method: "turn/started", params: { threadId, turn: { id: turnId, status: "inProgress" } } });
          const input = (msg.params?.input as Array<{ text?: string }> | undefined) ?? [];
          const text = input[0]?.text ?? "";
          let ended = false;
          for (const step of responder(text, turnCount)) {
            if (step.kind === "agentDelta") send({ method: "item/agentMessage/delta", params: { threadId, turnId, itemId: "m1", delta: step.text } });
            else if (step.kind === "reasoningDelta") send({ method: "item/reasoning/summaryTextDelta", params: { threadId, turnId, itemId: "r1", delta: step.text } });
            else if (step.kind === "agentMessage") send({ method: "item/completed", params: { threadId, turnId, item: { type: "agentMessage", id: step.id ?? "m1", text: step.text } } });
            else if (step.kind === "command") {
              send({ method: "item/started", params: { threadId, turnId, item: { type: "commandExecution", id: step.id, command: step.command, status: "inProgress" } } });
              send({ method: "item/completed", params: { threadId, turnId, item: { type: "commandExecution", id: step.id, command: step.command, status: step.failed ? "failed" : "completed", aggregatedOutput: step.output ?? "" } } });
            } else if (step.kind === "fileChange") {
              send({ method: "item/started", params: { threadId, turnId, item: { type: "fileChange", id: step.id, changes: [], status: "inProgress" } } });
              send({ method: "item/completed", params: { threadId, turnId, item: { type: "fileChange", id: step.id, changes: [], status: step.failed ? "failed" : "completed" } } });
            } else if (step.kind === "tokenUsage") {
              send({ method: "thread/tokenUsage/updated", params: { threadId, turnId, tokenUsage: { last: step.last, total: step.total ?? step.last, modelContextWindow: step.contextWindow ?? null } } });
            } else if (step.kind === "errorNote") {
              send({ method: "error", params: { threadId, turnId, error: { message: step.message }, willRetry: false } });
            } else if (step.kind === "requestApproval") {
              send({ id: 9000 + turnCount, method: "item/commandExecution/requestApproval", params: { threadId, turnId, itemId: step.id } });
            } else if (step.kind === "staleTurnEnd") {
              send({ method: "turn/completed", params: { threadId, turn: { id: "turn-STALE", status: "completed" } } });
            } else if (step.kind === "turnEnd") {
              ended = true;
              send({ method: "turn/completed", params: { threadId, turn: { id: turnId, status: step.status ?? "completed", durationMs: step.durationMs ?? 0, ...(step.errorMessage ? { error: { message: step.errorMessage } } : {}) } } });
            }
          }
          // A responder that never scripts an ending step (agentDelta-only, "turn never self-ends")
          // deliberately leaves the turn open server-side — no phantom auto-complete — until an
          // explicit turn/interrupt (or the session's abort) ends it. Only a real completion here
          // advances turnCount, so a still-open turn can't race ahead of interrupt()/abort().
          if (ended) {
            turnCount++;
            if (opts.dieAfterTurns != null && turnCount >= opts.dieAfterTurns) {
              killed = true;
              queueMicrotask(() => exitCb({ code: 1, message: "simulated crash" }));
            }
          }
          return;
        }
        // any other request: generic empty result
        send({ id: msg.id, result: {} });
      },
    };
    return transport;
  };
  return { spawn, requests, responses };
}
