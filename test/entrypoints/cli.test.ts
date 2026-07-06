import { describe, it, expect, vi } from "vitest";
import { PassThrough, Writable, Readable } from "node:stream";
import { renderServerMessage, runCli } from "../../src/entrypoints/cli.js";
import type { WebSocketLike } from "../../src/entrypoints/cli.js";

describe("renderServerMessage", () => {
  it("renders assistant messages", () => {
    const out = renderServerMessage(
      JSON.stringify({ type: "event", event: { type: "master.message", sessionId: "s1", role: "assistant", content: "hello" } }),
    );
    expect(out).toContain("hello");
  });

  it("renders worker events with id", () => {
    const out = renderServerMessage(
      JSON.stringify({
        type: "event",
        event: { type: "worker.event", sessionId: "s1", workerId: "a1", seq: 0, data: { kind: "message", role: "assistant", content: "sub says hi" } },
      }),
    );
    expect(out).toContain("a1");
    expect(out).toContain("sub says hi");
  });

  it("renders errors", () => {
    const out = renderServerMessage(JSON.stringify({ type: "error", message: "boom" }));
    expect(out).toContain("boom");
  });

  it("returns null for session.created (handled silently)", () => {
    expect(renderServerMessage(JSON.stringify({ type: "session.created", sessionId: "s1", cwd: "/x" }))).toBeNull();
  });

  it("returns a string note for invalid JSON rather than throwing", () => {
    expect(renderServerMessage("{bad")).not.toBeNull();
  });

  it("renders worker error events (message not lost)", () => {
    const out = renderServerMessage(
      JSON.stringify({
        type: "event",
        event: { type: "worker.event", sessionId: "s1", workerId: "a1", seq: 1, data: { kind: "error", message: "build failed" } },
      }),
    );
    expect(out).toContain("build failed");
  });

  it("renders worker result events with cost and turns", () => {
    const out = renderServerMessage(
      JSON.stringify({
        type: "event",
        event: { type: "worker.event", sessionId: "s1", workerId: "a1", seq: 2, data: { kind: "result", subtype: "success", costUsd: 0.03, numTurns: 4 } },
      }),
    );
    expect(out).toContain("4 turns");
  });
});

describe("runCli resilience (CLI-1)", () => {
  it("notifies the user and exits (does not hang) when the daemon drops the connection mid-session", async () => {
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    const fakeWs: WebSocketLike = {
      on(ev, cb) { (handlers[ev] ??= []).push(cb); },
      send() {},
      close() {},
    };
    const emit = (ev: string, ...args: unknown[]) => { for (const cb of handlers[ev] ?? []) cb(...args); };

    const input = new PassThrough(); // an open stdin that the user never types into
    const chunks: string[] = [];
    const output = new Writable({ write(c, _e, cb) { chunks.push(c.toString()); cb(); } });

    const done = runCli({ host: "h", port: 1, cwd: "/x", input, output, connect: () => fakeWs });
    emit("open"); // initial connection succeeds
    await new Promise((r) => setImmediate(r)); // advance up to for-await(rl)
    emit("close"); // daemon closes the socket — previously the CLI would cling to the dead socket and hang forever

    await done; // if it hangs, this test times out → regression detected
    // The disconnect note body is localized (ko/en per env), so assert the locale-agnostic prefix to prove a note fired.
    expect(chunks.join("")).toContain("[rookery] ");
  });

  it("CLI-4: does not drop piped input that arrives before the session is ready", async () => {
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    const sent: string[] = [];
    const fakeWs: WebSocketLike = {
      on(ev, cb) { (handlers[ev] ??= []).push(cb); },
      send(d) { sent.push(d); },
      close() { for (const cb of handlers["close"] ?? []) cb(); }, // like a real ws, emit 'close' on close (CLI-5 bounded close)
    };
    const emit = (ev: string, ...args: unknown[]) => { for (const cb of handlers[ev] ?? []) cb(...args); };

    const input = Readable.from(["hello\n"]); // one piped line, immediate EOF
    const output = new Writable({ write(_c, _e, cb) { cb(); } });

    const done = runCli({ host: "h", port: 1, cwd: "/x", input, output, connect: () => fakeWs });
    emit("open");
    await new Promise((r) => setImmediate(r)); // advance to the point where it waits for session.created
    emit("message", JSON.stringify({ type: "session.created", sessionId: "s1", cwd: "/x" }));
    await done;

    const parsed = sent.map((d) => JSON.parse(d) as { type: string; text?: string });
    expect(parsed.some((m) => m.type === "session.send" && m.text === "hello")).toBe(true);
  });

  it("[16] sends session.create with provider when opts.provider is set (codex CLI session)", async () => {
    const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
    const sent: string[] = [];
    const fakeWs: WebSocketLike = {
      on(ev, cb) { (handlers[ev] ??= []).push(cb); },
      send(d) { sent.push(d); },
      close() { for (const cb of handlers["close"] ?? []) cb(); },
    };
    const emit = (ev: string, ...args: unknown[]) => { for (const cb of handlers[ev] ?? []) cb(...args); };
    const input = Readable.from([]); // immediate EOF — no turns, just observe session.create
    const output = new Writable({ write(_c, _e, cb) { cb(); } });

    const done = runCli({ host: "h", port: 1, cwd: "/x", input, output, connect: () => fakeWs, provider: "codex" });
    emit("open");
    await new Promise((r) => setImmediate(r));
    emit("message", JSON.stringify({ type: "session.created", sessionId: "s1", cwd: "/x" }));
    await done;

    const create = sent.map((d) => JSON.parse(d) as { type: string; provider?: string }).find((m) => m.type === "session.create");
    expect(create?.provider).toBe("codex");
  });
});

describe("runCli localization (client-local strings)", () => {
  it("connected banner localizes to Korean from env LANG", async () => {
    const prev = process.env.LANG;
    const prevAll = process.env.LC_ALL;
    process.env.LANG = "ko_KR.UTF-8";
    delete process.env.LC_ALL;
    // The module-local cliLocale is computed at import time, so re-import the module fresh under ko.
    vi.resetModules();
    const mod = await import("../../src/entrypoints/cli.js");
    try {
      const handlers: Record<string, Array<(...a: unknown[]) => void>> = {};
      const fakeWs: WebSocketLike = {
        on(ev, cb) { (handlers[ev] ??= []).push(cb); },
        send() {},
        close() { for (const cb of handlers["close"] ?? []) cb(); },
      };
      const emit = (ev: string, ...args: unknown[]) => { for (const cb of handlers[ev] ?? []) cb(...args); };

      const input = Readable.from([]); // immediate EOF → loop ends after the banner
      const chunks: string[] = [];
      const output = new Writable({ write(c, _e, cb) { chunks.push(c.toString()); cb(); } });

      const done = mod.runCli({ host: "h", port: 1, cwd: "/x", input, output, connect: () => fakeWs });
      emit("open");
      await new Promise((r) => setImmediate(r));
      emit("message", JSON.stringify({ type: "session.created", sessionId: "s1", cwd: "/x" }));
      await done;

      // Korean banner from i18n cli.connected (currently a hardcoded English literal → RED until localized).
      expect(chunks.join("")).toContain("연결됨. 메시지를 입력하세요");
    } finally {
      if (prev === undefined) delete process.env.LANG; else process.env.LANG = prev;
      if (prevAll !== undefined) process.env.LC_ALL = prevAll;
    }
  });
});
