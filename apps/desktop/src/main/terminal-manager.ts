import fs from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveWorkRoot } from "./resolve-root.js";
import { mt } from "./i18n.js";

export interface PtyLike {
  onData(cb: (data: string) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}
export type SpawnPty = (shell: string, args: string[], opts: { cwd: string; cols: number; rows: number; env: NodeJS.ProcessEnv }) => PtyLike;
export interface TermInfo { id: string; title: string; cwd: string; exited: boolean }

export interface TerminalManagerDeps {
  spawn: SpawnPty;
  send: (channel: "term:data" | "term:exit", payload: unknown) => void;
  rookeryHome: string;
  exists?: (p: string) => boolean;
  homeDir?: string;
  defaultShell?: string;
  maxPerSession?: number;
  ringLimit?: number;
  idgen?: () => string;
  env?: NodeJS.ProcessEnv;
}

interface Entry { pty: PtyLike; sessionId: string; cwd: string; title: string; ring: string; attached: boolean; exited: boolean }

// Single owner of integrated-terminal PTYs (main process). Takes injected spawn/send/exists so it can be unit-tested without electron or node-pty.
export class TerminalManager {
  private readonly entries = new Map<string, Entry>();
  private readonly spawn: SpawnPty;
  private readonly send: TerminalManagerDeps["send"];
  private readonly rookeryHome: string;
  private readonly exists: (p: string) => boolean;
  private readonly homeDir: string;
  private readonly shell: string;
  private readonly maxPerSession: number;
  private readonly ringLimit: number;
  private readonly idgen: () => string;
  private readonly env: NodeJS.ProcessEnv;

  constructor(deps: TerminalManagerDeps) {
    this.spawn = deps.spawn;
    this.send = deps.send;
    this.rookeryHome = deps.rookeryHome;
    this.exists = deps.exists ?? fs.existsSync;
    this.homeDir = deps.homeDir ?? homedir();
    this.shell = deps.defaultShell ?? process.env.SHELL ?? "/bin/zsh";
    this.maxPerSession = deps.maxPerSession ?? 8;
    this.ringLimit = deps.ringLimit ?? 256 * 1024;
    this.idgen = deps.idgen ?? (() => randomUUID());
    this.env = deps.env ?? { ...process.env, TERM: "xterm-256color" };
  }

  // Priority: live worker worktree > session cwd > home. The worktree is resolved by main from rookeryHome+subId (no protocol change).
  resolveCwd(opts: { subId?: string; cwd?: string }): string {
    return resolveWorkRoot({ rookeryHome: this.rookeryHome, homeDir: this.homeDir, exists: this.exists }, opts);
  }

  create(opts: { sessionId: string; subId?: string; cwd?: string; cols?: number; rows?: number }): { id?: string; error?: string } {
    const live = [...this.entries.values()].filter((e) => e.sessionId === opts.sessionId && !e.exited).length;
    if (live >= this.maxPerSession) return { error: mt("terminal.tooMany", { max: this.maxPerSession }) };
    const cwd = this.resolveCwd(opts);
    let pty: PtyLike;
    try {
      pty = this.spawn(this.shell, [], { cwd, cols: opts.cols ?? 80, rows: opts.rows ?? 24, env: this.env });
    } catch (e) {
      return { error: mt("terminal.spawnFailed", { message: (e as Error).message }) };
    }
    const id = this.idgen();
    const entry: Entry = { pty, sessionId: opts.sessionId, cwd, title: basename(cwd) || "zsh", ring: "", attached: false, exited: false };
    this.entries.set(id, entry);
    pty.onData((data) => {
      entry.ring = (entry.ring + data).slice(-this.ringLimit);
      if (entry.attached) this.send("term:data", { id, data });
    });
    pty.onExit(({ exitCode, signal }) => {
      entry.exited = true;
      this.send("term:exit", { id, exitCode, signal });
    });
    return { id };
  }

  // Called when the renderer shows the tab — returns the buffered scrollback and turns on live data emit from then on.
  attach(id: string): { scrollback: string } {
    const e = this.entries.get(id);
    if (!e) return { scrollback: "" };
    e.attached = true;
    return { scrollback: e.ring };
  }
  detach(id: string): void { const e = this.entries.get(id); if (e) e.attached = false; }
  write(id: string, data: string): void { this.entries.get(id)?.pty.write(data); }
  resize(id: string, cols: number, rows: number): void { this.entries.get(id)?.pty.resize(cols, rows); }
  kill(id: string): void {
    const e = this.entries.get(id);
    if (!e) return;
    try { e.pty.kill(); } catch { /* best-effort */ }
    this.entries.delete(id);
  }
  list(sessionId: string): TermInfo[] {
    return [...this.entries].filter(([, e]) => e.sessionId === sessionId).map(([id, e]) => ({ id, title: e.title, cwd: e.cwd, exited: e.exited }));
  }
  killSession(sessionId: string): void {
    for (const [id, e] of this.entries) if (e.sessionId === sessionId) { try { e.pty.kill(); } catch { /* */ } this.entries.delete(id); }
  }
  killAll(): void {
    for (const [, e] of this.entries) { try { e.pty.kill(); } catch { /* */ } }
    this.entries.clear();
  }
}
