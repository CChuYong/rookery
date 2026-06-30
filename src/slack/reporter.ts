import type { CoreEvent } from "../core/events.js";
import type { SlackClient, ChatStreamerLike, ThreadTarget, AppendPayload, PlanChunk } from "./types.js";
import { truncateBytes } from "../core/truncate.js";
import { t, KO, type Locale } from "../core/i18n.js";
import { basename } from "node:path";

type I18nKey = keyof typeof KO;

// Comfortably below Slack's message text limit (~40000 chars), so the post fallback doesn't lose it again to msg_too_long.
const SLACK_TEXT_MAX_BYTES = 38000;

// Append once each time this many prose deltas accumulate — deterministically controls chat.appendStream frequency (live feel vs rate balance).
const PROSE_FLUSH = 40;
// Thinking is shown as a collapsed task card in the plan (collapsed by default → long reasoning doesn't clutter the body).
// details must be a plain string (sending a rich_text object gets the chunk schema rejected → fallback spam). Capped below the chunk text limit (~256).
const THINK_ID = "__thinking__";
const THINK_FLUSH = 120; // Refresh the card details once accumulated reasoning grows by this much more
const DETAIL_MAX = 200; // task card details string cap (safety margin under the chunk ~256 limit)

function slackErrorCode(err: unknown): string | undefined {
  const e = err as { data?: { error?: string } };
  return e?.data?.error;
}

function fmtTokens(n: number): string {
  return n < 1000 ? String(n) : `${(n / 1000).toFixed(1)}k`;
}
function fmtDuration(ms: number): string {
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

function payloadText(p: AppendPayload): string {
  if ("markdown_text" in p) return p.markdown_text;
  return p.chunks
    .filter((c): c is { type: "markdown_text"; text: string } => c.type === "markdown_text")
    .map((c) => c.text)
    .join("");
}

// Text for the post fallback. If there's no markdown (= task_update chunks only), summarize title/status to prevent silent loss.
function payloadFallbackText(p: AppendPayload): string {
  const md = payloadText(p);
  if (md) return md;
  if ("chunks" in p) {
    return p.chunks
      .filter((c): c is Extract<PlanChunk, { type: "task_update" }> => c.type === "task_update")
      .map((c) => `• ${c.title} — ${c.status}`)
      .join("\n");
  }
  return "";
}

export class SlackThreadReporter {
  private streamer: ChatStreamerLike | null = null;
  private tail: Promise<void> = Promise.resolve();
  private toolTasks = new Map<string, string>(); // toolId -> display name (input is loaded into the card only at start and not stored — avoids doubling on append)
  private lastWorkerStatus = new Map<string, string>(); // workerId -> last terminal status posted (prevents duplicate posts from double emit)
  private proseBuf = ""; // prose deltas not yet flushed (controls append frequency)
  private streamedText = ""; // prose already sent to the stream in this block (prevents master.message duplication)
  private thinkingBuf = ""; // accumulated reasoning summary for this turn (card details)
  private thinkingSent = 0; // length of thinkingBuf already sent to the card (only the rest is sent as a delta — prevents append accumulation)
  private thinkingActive = false; // whether the reasoning card is in_progress
  private thinkingBroken = false; // turned off if the reasoning card append has ever failed (silently give up instead of spamming)

  constructor(
    private readonly client: SlackClient,
    private readonly target: ThreadTarget,
    private readonly getLocale: () => Locale = () => "ko",
  ) {}

  onEvent(e: CoreEvent): void {
    this.tail = this.tail.then(() => this.handle(e)).catch((err) => {
      // Don't fully hide handler failures (slack-error-tail-swallow) — but keep the adapter itself alive.
      process.stderr.write(`[rookery] slack reporter handler error: ${String(err)}\n`);
    });
  }

  idle(): Promise<void> {
    return this.tail;
  }

  private openStream(): ChatStreamerLike {
    return this.client.chatStream({
      channel: this.target.channel,
      thread_ts: this.target.threadTs,
      buffer_size: 1,
      task_display_mode: "plan",
      ...(this.target.userId ? { recipient_user_id: this.target.userId } : {}),
      recipient_team_id: this.target.team,
    });
  }

  private async append(payload: AppendPayload, depth = 0): Promise<void> {
    if (!this.streamer) this.streamer = this.openStream();
    try {
      await this.streamer.append(payload);
    } catch (err) {
      const code = slackErrorCode(err) ?? "";
      // Diagnostic: stream append failures were previously silent → the reason for a plain-post fallback was invisible.
      process.stderr.write(`[rookery] slack stream append fell back to post (code=${code || String(err)})\n`);
      this.streamer = null;
      // msg_too_long: retrying the same payload fails again (infinite retry + eventual silent loss).
      // Don't retry — truncate the text to the byte budget and send it as a regular post.
      if (code === "msg_too_long") {
        const t = payloadFallbackText(payload);
        if (t) await this.post(t);
        return;
      }
      // message_not_in_streaming_state: recoverable by reopening the stream → retry a limited number of times.
      if (code === "message_not_in_streaming_state" && depth < 2) {
        await this.append(payload, depth + 1);
        return;
      }
      // Otherwise (or retries exhausted): flush via a regular post so at least the text isn't lost (summarize if task-only).
      const t = payloadFallbackText(payload);
      if (t) await this.post(t);
    }
  }

  // Cleanup: wait for the in-flight tail to finish + close the open streamer (prevents orphaned streaming messages on LRU evict/shutdown).
  async dispose(): Promise<void> {
    await this.tail.catch(() => {});
    if (this.streamer) {
      const s = this.streamer;
      this.streamer = null;
      try { await s.stop(); } catch { /* best-effort */ }
    }
  }

  private async post(text: string): Promise<void> {
    try {
      // Send it byte-truncated — otherwise the post fallback also loses it again to msg_too_long (G-UNICODE).
      await this.client.chat.postMessage({ channel: this.target.channel, thread_ts: this.target.threadTs, text: truncateBytes(text, SLACK_TEXT_MAX_BYTES) });
    } catch (err) {
      // Doesn't kill the adapter, but prevents silent loss — log what got dropped (slack-silent-post-loss).
      process.stderr.write(`[rookery] slack post failed: ${String(err)}\n`);
    }
  }

  private metricsBlocks(m: { contextTokens: number; contextWindow: number; numTurns: number; durationMs: number }): unknown[] {
    const parts: string[] = [];
    if (m.contextWindow > 0) parts.push(`context ${Math.round((m.contextTokens / m.contextWindow) * 100)}%`);
    parts.push(`${fmtTokens(m.contextTokens)} tok`);
    parts.push(`${m.numTurns} turns`);
    parts.push(fmtDuration(m.durationMs));
    return [{ type: "context", elements: [{ type: "mrkdwn", text: `🧠 ${parts.join(" · ")}` }] }];
  }

  // ⚠️ details (body) is appended (accumulated) on updates to the same id → load each piece 'only once'.
  // Only when non-empty, send once truncated to DETAIL_MAX without trimming (preserving whitespace between deltas).
  private taskChunk(id: string, title: string, status: "in_progress" | "complete" | "error", details?: string): PlanChunk {
    const has = !!details && details.trim().length > 0;
    return { type: "task_update", id, title, status, ...(has ? { details: details!.slice(0, DETAIL_MAX) } : {}) };
  }

  // Flush the accumulated prose deltas to the stream all at once (track the accumulated amount via streamedText → prevents master.message duplication).
  private async flushProse(): Promise<void> {
    if (!this.proseBuf) return;
    const text = this.proseBuf;
    this.proseBuf = "";
    this.streamedText += text;
    await this.append({ markdown_text: text });
  }

  // Reasoning card (task_update, fixed id THINK_ID). Since details is appended, only send the 'newly grown part (delta)'.
  // best-effort: on failure, silently turn it off (thinkingBroken) instead of spamming (fallback post). No effect on the answer stream.
  private async appendThinkCard(status: "in_progress" | "complete", details: string): Promise<void> {
    if (this.thinkingBroken) return;
    if (!this.streamer) this.streamer = this.openStream();
    try {
      await this.streamer.append({ chunks: [this.taskChunk(THINK_ID, t(this.getLocale(), "slack.thinking"), status, details)] });
    } catch {
      this.thinkingBroken = true; // card append failed → give up on the reasoning card for this instance (prevents spam)
    }
  }

  // When the answer starts or the turn ends, close the reasoning card as complete (along with any remaining delta).
  private async closeThinking(): Promise<void> {
    if (!this.thinkingActive) return;
    this.thinkingActive = false;
    const rest = this.thinkingBuf.slice(this.thinkingSent);
    this.thinkingSent = this.thinkingBuf.length;
    await this.appendThinkCard("complete", rest);
  }

  // Reset turn-boundary state (so the next turn starts clean). thinkingBroken is preserved (once broken, stays off).
  private resetTurn(): void {
    this.proseBuf = "";
    this.streamedText = "";
    this.thinkingBuf = "";
    this.thinkingSent = 0;
    this.thinkingActive = false;
  }

  private async handle(e: CoreEvent): Promise<void> {
    switch (e.type) {
      case "master.message.delta":
        await this.closeThinking();
        this.proseBuf += e.delta;
        if (this.proseBuf.length >= PROSE_FLUSH) await this.flushProse(); // once accumulated, flush live
        return;
      case "master.message": {
        if (e.role === "user") return; // user messages are already in the thread — don't echo them back (the daemon's live user echo is desktop-pending only).
        // Block complete. Subtract what was already streamed via deltas and send only the 'remainder' (prevents duplication).
        // If there were no deltas at all (streamedText empty), send the full body (preserves the non-streaming path/tests).
        await this.closeThinking();
        await this.flushProse();
        const remainder = e.content.startsWith(this.streamedText)
          ? e.content.slice(this.streamedText.length)
          : (this.streamedText ? "" : e.content);
        if (remainder) await this.append({ markdown_text: remainder });
        this.streamedText = ""; // block boundary
        return;
      }
      case "master.thinking.delta":
        // Live-update the reasoning summary into the plan's collapsed reasoning task card details. Since details is appended, send 'only the new delta'.
        this.thinkingBuf += e.delta;
        if (this.thinkingBuf.length - this.thinkingSent >= THINK_FLUSH) {
          const delta = this.thinkingBuf.slice(this.thinkingSent);
          this.thinkingSent = this.thinkingBuf.length;
          this.thinkingActive = true;
          await this.appendThinkCard("in_progress", delta);
        }
        return;
      case "master.tool": {
        await this.closeThinking(); // close the reasoning card before the tool card
        await this.flushProse(); // if there's unflushed prose before the tool card, flush it first
        if (e.phase === "start") {
          this.toolTasks.set(e.toolId, e.name);
          await this.append({ chunks: [this.taskChunk(e.toolId, e.name, "in_progress", e.input)] }); // the call input is loaded 'only once' here
        } else if (e.phase === "end") {
          const title = this.toolTasks.get(e.toolId) ?? e.name ?? e.toolId;
          this.toolTasks.delete(e.toolId);
          // Success: status only → complete (input was already loaded at start — resending would double it via append). Failure: error body (new info) only.
          await this.append({ chunks: [this.taskChunk(e.toolId, title, e.ok === false ? "error" : "complete", e.ok === false ? e.result : undefined)] });
        }
        // Ignore phase "progress" — don't prematurely close an in-progress card as complete/error.
        return;
      }
      case "master.result": {
        await this.closeThinking();
        await this.flushProse();
        for (const [id, title] of this.toolTasks) {
          await this.append({ chunks: [this.taskChunk(id, title, "complete")] }); // status only (input was already loaded at start)
        }
        this.toolTasks.clear();
        if (this.streamer) {
          const s = this.streamer;
          this.streamer = null;
          try {
            await s.stop({ blocks: this.metricsBlocks(e) });
          } catch {
            /* ignore stop failure */
          }
        }
        this.resetTurn();
        return;
      }
      case "worker.status": {
        // idle/running recur every turn → suppress to prevent spam. Notify only on terminal states (done is the success line, slack-idle-status-spam).
        if (e.status === "running" || e.status === "idle") return;
        // worker.status: two writers (Worker.transition + FleetOrchestrator.setStatus) each emit the terminal state →
        // post the same terminal state for the same worker only once (prevents duplicate messages). Desktop/CLI overwrite the status field so they're idempotent (no effect).
        if (this.lastWorkerStatus.get(e.workerId) === e.status) return;
        this.lastWorkerStatus.set(e.workerId, e.status);
        const icon = e.status === "done" ? "✅" : "🤖";
        await this.post(`${icon} \`${e.workerId}\` → ${e.status}`);
        return;
      }
      case "error": {
        // Treat an error as a turn end — close remaining tasks as error and close the stream.
        // (Previously the stream was left open, so the next turn's append polluted a dead stream.)
        await this.closeThinking();
        await this.flushProse();
        if (this.streamer) {
          await this.append({ chunks: [{ type: "markdown_text", text: `⚠️ ${e.message}` }] });
          for (const [id, title] of this.toolTasks) {
            await this.append({ chunks: [this.taskChunk(id, title, "error")] });
          }
          this.toolTasks.clear();
          const s = this.streamer;
          this.streamer = null;
          try {
            await s.stop();
          } catch {
            /* ignore stop failure */
          }
        } else {
          await this.post(`⚠️ ${e.message}`);
        }
        this.resetTurn();
        return;
      }
      case "master.notice": {
        // System notice (context compaction/retry/fallback, etc.) — a faint one-liner so a pause doesn't look like a 'hang'.
        await this.flushProse();
        const txt = e.code ? t(this.getLocale(), e.code as I18nKey, e.params) : e.text;
        await this.append({ markdown_text: `\n_ℹ️ ${txt}_\n` });
        return;
      }
      case "worker.event": {
        // Worker activity (message/delta/tool) is sufficiently covered by the plan card/transcript, but surface errors into the thread
        // (slack-worker-event-deltas-dropped) — otherwise worker failures aren't visible in the thread.
        if (e.data.kind === "error") await this.post(`⚠️ \`${e.workerId}\`: ${e.data.message}`);
        return;
      }
      case "worker.spawned": {
        // Surface worker spawn as a plan card (UX-9) — show which worker started / in which repo. Doesn't touch status/title (setStatus/setTitle).
        await this.flushProse();
        const repo = basename(e.repoPath) || e.repoPath; // node:path basename handles the daemon host's separators (\\ on Windows)
        await this.append({ chunks: [this.taskChunk(`worker:${e.workerId}`, t(this.getLocale(), "slack.worker", { label: e.label || e.workerId }), "in_progress", t(this.getLocale(), "slack.workerRepo", { repo }))] });
        return;
      }
      default:
        // master.system, etc. → ignore
        return;
    }
  }
}
