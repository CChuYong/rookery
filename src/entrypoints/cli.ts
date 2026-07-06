import readline from "node:readline";
import { WebSocket } from "ws";
import type { WorkerEventData } from "../core/events.js";
import { truncateBytes } from "../core/truncate.js";
import { t, resolveLocale } from "../core/i18n.js";

// Locale for client-local strings — the CLI is a thin client with no DB, so it's decided once from env.
const cliLocale = resolveLocale(process.env.LC_ALL ?? process.env.LANG);

export interface WebSocketLike {
  on(event: string, cb: (...args: unknown[]) => void): void;
  send(data: string): void;
  close(): void;
}

export function renderServerMessage(raw: string): string | null {
  let msg: Record<string, unknown>;
  try {
    msg = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return `[rookery] unparseable server message: ${raw}`;
  }

  switch (msg.type) {
    case "session.created":
      return null;
    case "error":
      return `[error] ${String(msg.message)}`;
    case "session.list.result": {
      const sessions = msg.sessions as Array<{ id: string; cwd: string; status: string }>;
      return sessions.map((s) => `  ${s.id} [${s.status}] ${s.cwd}`).join("\n") || "  (no sessions)";
    }
    case "worker.list.result": {
      const items = msg.workers as Array<{ id: string; label: string; repoPath: string; status: string }>;
      return items.map((a) => `  ${a.id} [${a.status}] ${a.label} (${a.repoPath})`).join("\n") || "  (no workers)";
    }
    case "event": {
      const event = msg.event as Record<string, unknown>;
      switch (event.type) {
        case "master.message":
          return `\n${String(event.content)}`;
        case "master.result":
          return `[turn done] $${String(event.costUsd)} · ${String(event.numTurns)} turns`;
        case "master.system":
          return null;
        case "worker.spawned":
          return `[worker ${String(event.workerId)} spawned] ${String(event.label)} (${String(event.repoPath)})`;
        case "worker.status":
          return `[worker ${String(event.workerId)}] → ${String(event.status)}`;
        case "worker.event": {
          const data = event.data as WorkerEventData;
          let body: string;
          switch (data.kind) {
            case "system":
              body = data.text;
              break;
            case "message":
              body = data.content;
              break;
            case "result":
              body = `${data.subtype} $${data.costUsd} · ${data.numTurns} turns`;
              break;
            case "error":
              body = `error: ${data.message}`;
              break;
            default:
              body = (data as { kind: string }).kind;
          }
          return `  [${String(event.workerId)}] ${body}`;
        }
        case "error":
          return `[error] ${String(event.message)}`;
        default:
          return null;
      }
    }
    default:
      return null;
  }
}

export async function runCli(opts: {
  host: string;
  port: number;
  cwd: string;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  token?: string;
  provider?: "claude" | "codex"; // backend for the CLI-created master session (finding [16]); absent → daemon default (claude)
  connect?: (url: string) => WebSocketLike;
}): Promise<void> {
  const url = `ws://${opts.host}:${opts.port}/ws${opts.token ? `?token=${encodeURIComponent(opts.token)}` : ""}`;
  const ws: WebSocketLike = opts.connect ? opts.connect(url) : (new WebSocket(url) as unknown as WebSocketLike);
  let sessionId: string | null = null;

  await new Promise<void>((resolve, reject) => {
    ws.on("open", () => resolve());
    ws.on("error", (err) => reject(err));
  });

  ws.send(JSON.stringify({ type: "session.create", cwd: opts.cwd, ...(opts.provider ? { provider: opts.provider } : {}) }));

  // CLI-4: session.created readiness signal. So the first line of piped stdin isn't lost by arriving before sessionId,
  // we wait for this before starting the input loop.
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((r) => { resolveReady = r; });

  // CLI-3: turn watchdog. If there's no response at all for a while after send, notify the user (protocol reqId/ack is lower priority).
  const TURN_SILENCE_MS = 60000;
  let awaitingResponse = false;
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  const clearWatchdog = () => { if (watchdog) { clearTimeout(watchdog); watchdog = undefined; } };
  const armWatchdog = () => {
    clearWatchdog();
    watchdog = setTimeout(() => {
      opts.output.write(`[rookery] ${t(cliLocale, "cli.noResponse")}\n`);
    }, TURN_SILENCE_MS);
    (watchdog as { unref?: () => void }).unref?.();
  };

  // CLI-1: if the socket dies after open (daemon shutdown/crash), notify and end the input loop.
  // Since rl is created after waiting for ready (below), onDisconnect guards with rl?.close().
  let connectionLost = false;
  let rl: readline.Interface | undefined;
  const onDisconnect = (note: string) => {
    if (connectionLost) return;
    connectionLost = true;
    clearWatchdog();
    resolveReady(); // release it so we don't hang if disconnected while waiting on ready
    opts.output.write(`[rookery] ${note}\n`);
    rl?.close(); // if already created, terminate the for-await
  };
  ws.on("close", () => onDisconnect(t(cliLocale, "cli.connClosed")));
  ws.on("error", () => onDisconnect(t(cliLocale, "cli.connError")));

  ws.on("message", (data: unknown) => {
    const raw = typeof data === "string" ? data : String(data);
    let evType: string | undefined;
    let topType: string | undefined;
    try {
      const parsed = JSON.parse(raw) as { type?: string; sessionId?: string; event?: { type?: string } };
      topType = parsed.type;
      if (parsed.type === "session.created" && parsed.sessionId) { sessionId = parsed.sessionId; resolveReady(); }
      evType = parsed.type === "event" ? parsed.event?.type : undefined;
    } catch {
      // On parse failure, skip the sessionId capture; renderServerMessage handles it with its own guard.
    }
    // On turn end (result or error — both event-wrapped and top-level), clear the watchdog. Otherwise re-arm only while awaiting a response (CLI-3).
    // Errors must also be treated as turn end — a failed turn sends only error without agent.result, so otherwise a false alarm fires after 60s.
    const turnEnded = evType === "master.result" || evType === "error" || topType === "error";
    if (turnEnded) { awaitingResponse = false; clearWatchdog(); }
    else if (awaitingResponse) armWatchdog();
    const rendered = renderServerMessage(raw);
    if (rendered !== null) opts.output.write(truncateBytes(rendered, 100_000) + "\n"); // cap so a giant single line doesn't clog the terminal (CLI-6)
  });

  // Wait until the session is ready (or a 5s timeout) before reading input → prevents losing the first piped line (CLI-4).
  await Promise.race([ready, new Promise<void>((r) => { const t = setTimeout(r, 5000); (t as { unref?: () => void }).unref?.(); })]);

  if (!connectionLost) {
    // Create rl right before the loop — if an await sits between createInterface and for-await, the first line (line/close) is missed.
    rl = readline.createInterface({ input: opts.input });
    opts.output.write(`rookery> ${t(cliLocale, "cli.connected")}\n`);
    for await (const line of rl) {
      if (connectionLost) break;
      const text = line.trim();
      if (!text) continue;
      if (!sessionId) {
        opts.output.write(`[rookery] ${t(cliLocale, "cli.sessionNotReady")}\n`);
        continue;
      }
      ws.send(JSON.stringify({ type: "session.send", sessionId, text }));
      awaitingResponse = true;
      armWatchdog();
    }
  }
  clearWatchdog();
  if (!connectionLost) {
    // Wait (bounded) for ws.close()'s close handshake to finish before returning — otherwise the process may
    // exit before flushing (CLI-5). Set connectionLost first to suppress onDisconnect's "closed by daemon" message.
    connectionLost = true;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      ws.on("close", finish);
      const t = setTimeout(finish, 1000);
      (t as { unref?: () => void }).unref?.();
      ws.close();
    });
  }
}
