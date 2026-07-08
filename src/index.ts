#!/usr/bin/env node
import { spawn } from "node:child_process";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { loadConfig, detectAuth } from "./config.js";
import { startDaemon } from "./daemon/server.js";
import { loadOrCreateToken } from "./daemon/auth.js";
import { runCli } from "./entrypoints/cli.js";

export function parseArgs(argv: string[]): { command: "daemon" | "cli"; provider?: "claude" | "codex" } {
  const command = argv[0] === "daemon" ? "daemon" : "cli";
  // `--provider claude|codex` (or `--provider=…`) picks the CLI-created master session's backend
  // (finding [16]) — without it the CLI thin client could only ever create claude sessions, unlike
  // desktop/Slack. An unrecognized value is ignored (the daemon defaults an absent provider to claude).
  let provider: "claude" | "codex" | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = a === "--provider" ? argv[i + 1] : a.startsWith("--provider=") ? a.slice("--provider=".length) : undefined;
    if (v === "claude" || v === "codex") provider = v;
  }
  return { command, ...(provider ? { provider } : {}) };
}

// Path resolution so the daemon loads the repo .env consistently no matter how it
// starts (CLI auto-spawn / direct run / desktop spawn) (CLI-ENVFILE). One level above dist/index.js is the repo root.
export function resolveEnvFilePath(selfPath: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = env.ROOKERY_ENV_FILE?.trim();
  return override || path.resolve(path.dirname(selfPath), "..", ".env");
}

// Apply the repo .env (if present) before loading config. Node does not overwrite env it already has,
// so explicitly exported environment variables take precedence. Unifies what the desktop did with --env-file across every entry point.
function loadEnvFileIfPresent(): void {
  const envPath = resolveEnvFilePath(fileURLToPath(import.meta.url));
  if (!fs.existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    // best-effort: a format error should not block startup, but silently acting as if it "doesn't exist" makes diagnosis hard → emit a one-line warning.
    process.stderr.write(`[rookery] WARNING: failed to load env file ${envPath}: ${String(err)}\n`);
  }
}

// Prevent a stray unhandledRejection/uncaughtException from killing the resident daemon. The daemon is a single process
// with no supervisor, so log-then-survive is safer for preserving the fleet than always crashing (the cause is recorded in daemon.log).
export function formatProcessError(kind: string, err: unknown): string {
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
  return `[rookery] ${kind}: ${detail}\n`;
}
function installProcessGuards(): void {
  process.on("unhandledRejection", (reason) => process.stderr.write(formatProcessError("unhandledRejection", reason)));
  process.on("uncaughtException", (err) => process.stderr.write(formatProcessError("uncaughtException", err)));
}

function pingHealth(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host, port, path: "/health", timeout: 500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureDaemon(host: string, port: number, home: string): Promise<void> {
  if (await pingHealth(host, port)) return;
  const self = fileURLToPath(import.meta.url);
  // Send the daemon's stdout/stderr to a log file so startup failures (e.g. missing API key) can be diagnosed.
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const logPath = path.join(home, "daemon.log");
  const fd = fs.openSync(logPath, "a", 0o600);
  const child = spawn(process.execPath, [self, "daemon"], {
    detached: true,
    stdio: ["ignore", fd, fd],
    env: process.env,
  });
  // If the child dies before becoming healthy (wrong Node ABI, throw during boot, etc.), don't wait out the 5s polling timeout —
  // diagnose immediately via exit code + log path (ENSUREDAEMON-exit-observe). Filled in from callbacks, so keep it in a holder
  // object (closure assignment isn't tracked by TS CFA, so a plain let would narrow to never).
  const childState: { exit: { code: number | null; signal: NodeJS.Signals | null } | null; err: Error | null } = { exit: null, err: null };
  child.on("error", (e) => { childState.err = e; });
  child.on("exit", (code, signal) => { childState.exit = { code, signal }; });
  child.unref();
  // Wait for startup (up to ~5s)
  for (let i = 0; i < 50; i++) {
    if (await pingHealth(host, port)) return;
    if (childState.err || childState.exit) {
      // The child died, but due to a race (another CLI started the daemon first → our child exits with EADDRINUSE)
      // the daemon may already be healthy → only conclude failure after one more check.
      if (await pingHealth(host, port)) return;
      if (childState.err) throw new Error(`failed to spawn daemon: ${childState.err.message} — see ${logPath}`);
      throw new Error(`daemon exited early (code ${childState.exit?.code ?? "?"}, signal ${childState.exit?.signal ?? "?"}) before becoming healthy — see ${logPath}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`daemon did not become healthy in time — see ${logPath}`);
}

// CLI usage text (interop QW7) — documents the `--provider` flag so switching the CLI-created session's
// backend is self-discoverable instead of undocumented. Exported for a direct unit test.
export function formatUsage(): string {
  return [
    "rookery — orchestrator daemon + thin CLI client",
    "",
    "Usage:",
    "  rookery [--provider <claude|codex>]   Start the CLI (auto-starts a daemon if none is running)",
    "  rookery daemon                        Run the daemon in the foreground",
    "",
    "Options:",
    "  --provider <claude|codex>             Agent backend for the CLI-created master session (default: claude)",
    "  -h, --help                            Show this help",
  ].join("\n");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(formatUsage() + "\n");
    return;
  }
  const { command, provider } = parseArgs(argv);
  installProcessGuards(); // keep a stray rejection/exception from killing the resident daemon (log-then-survive)
  loadEnvFileIfPresent(); // apply .env before loading config (consistent across CLI/daemon/desktop paths, CLI-ENVFILE)
  const config = loadConfig();

  if (command === "daemon") {
    process.stderr.write("[rookery] Prompts and repository contents are sent to Anthropic's API for processing.\n");
    // shutdown is defined before startDaemon so it can be wired to the POST /shutdown endpoint (onShutdownRequest).
    // daemon is assigned before any request can arrive (startDaemon resolves only after the server is listening).
    let shuttingDown = false;
    let daemon: Awaited<ReturnType<typeof startDaemon>>;
    const shutdown = (): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      void daemon.close().then(() => process.exit(0));
    };
    try {
      daemon = await startDaemon({ config, onShutdownRequest: shutdown });
    } catch (err) {
      // Bind/boot failure: exit non-zero instead of surviving as a half-started process (the lock and DB were
      // already released by startDaemon's own cleanup). ensureDaemon/desktop read this from daemon.log.
      process.stderr.write(`[rookery] daemon failed to start: ${String(err)}\n`);
      process.exit(1);
    }
    // detectAuth runs AFTER startDaemon so an in-app (settings DB) key, which applyApiKeyToEnv injects into
    // process.env during startup, is reflected here — otherwise a DB-key-only user gets a false "no auth" warning.
    // Even without any key, OAuth (claude login) can still authenticate, so we don't hard-gate.
    const auth = detectAuth();
    process.stdout.write(`rookery daemon listening on ${config.host}:${daemon.port} (auth: ${auth})\n`);
    if (auth === "unknown") {
      process.stdout.write(
        "[rookery] No ANTHROPIC_API_KEY and no Claude Code credentials detected — " +
          "turns will fail until you set a key in Settings, set ANTHROPIC_API_KEY, or run `claude login`.\n",
      );
    }
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
    return;
  }

  await ensureDaemon(config.host, config.port, config.home);
  await runCli({
    host: config.host,
    port: config.port,
    cwd: process.cwd(),
    input: process.stdin,
    output: process.stdout,
    token: loadOrCreateToken(config.tokenPath), // read the token the daemon already wrote in ensureDaemon
    provider, // --provider claude|codex (undefined → daemon defaults to claude)
  });
}

// Call main only when run directly (not executed on import → test-safe)
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  });
}
