import { spawn as nodeSpawn } from "node:child_process";
import { createInterface } from "node:readline";

// Byte-transport port under the Codex JSON-RPC client. Real impl spawns `codex app-server`;
// tests inject a scripted fake (test/helpers/fake-codex.ts).
export interface CodexTransport {
  write(line: string): void;
  onLine(cb: (line: string) => void): void;
  onExit(cb: (info: { code: number | null; message?: string }) => void): void;
  kill(): void;
}

export type CodexSpawn = (opts: { env?: NodeJS.ProcessEnv }) => CodexTransport;

// Real transport: one `codex app-server` child per session, newline-delimited JSON-RPC on stdio.
// `bin` is a resolver (Settings-backed) so runtime changes apply to new sessions.
// AUTH NOTE (verified against rust-v0.142.5 app-server/src/lib.rs:493): the app-server does NOT
// read CODEX_API_KEY from env (that only works for `codex exec`). Auth comes from
// $CODEX_HOME/auth.json (`codex login` / `codex login --with-api-key`). An in-app API-key setting
// would need CODEX_HOME redirection + `account/login/start` provisioning — deferred to P1.5.
export function realCodexSpawn(bin: () => string): CodexSpawn {
  return ({ env }) => {
    const child = nodeSpawn(bin(), ["app-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    const lineCbs: Array<(line: string) => void> = [];
    const exitCbs: Array<(info: { code: number | null; message?: string }) => void> = [];
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => { for (const cb of lineCbs) cb(line); });
    let stderrTail = "";
    child.stderr.on("data", (d: Buffer) => { stderrTail = (stderrTail + d.toString()).slice(-2000); });
    // Writing to stdin in the window after the child dies but before 'exit' fires raises an
    // async 'error' (EPIPE) on the stream — without a listener that is an UNCAUGHT exception
    // that kills the whole daemon. The exit callback already reports the death; swallow here.
    child.stdin.on("error", () => {});
    // spawn failure (ENOENT etc.) surfaces as 'error', not 'exit' — funnel both into onExit.
    child.on("error", (err) => { for (const cb of exitCbs) cb({ code: null, message: String(err) }); });
    child.on("exit", (code) => { for (const cb of exitCbs) cb({ code, message: stderrTail || undefined }); });
    return {
      write: (line) => { try { child.stdin.write(line + "\n", () => {}); } catch { /* dying child — exit cb reports */ } },
      onLine: (cb) => { lineCbs.push(cb); },
      onExit: (cb) => { exitCbs.push(cb); },
      kill: () => { try { child.kill(); } catch { /* already dead */ } },
    };
  };
}
