import os from "node:os";
import path from "node:path";
import fs from "node:fs";

export interface Config {
  home: string;
  dbPath: string;
  pidPath: string;
  tokenPath: string;
  host: string;
  port: number;
  masterModel: string;
  workerModel: string;
  masterEffort: string; // Global default effort (for Slack and the default entrypoint). The UI can override it per session/spawn.
  workerEffort: string;
  linearApiKey?: string; // Default key for Linear integration (env fallback). The DB settings' linearApiKey takes precedence.
  anthropicApiKey?: string; // Default Anthropic API key (env fallback). The DB settings' anthropicApiKey takes precedence; injected into process.env at boot/on save.
  fleet: { worktreesDir: string };
  // cwd/allowedUsers/allowAll have moved to settings (DB). Only the tokens remain in env (as a settings fallback).
  slack: { botToken?: string; appToken?: string };
  // refreshMs has moved to settings (DB). Only the ccusage command stays in env.
  usage: { ccusageCmd: string[] };
}

function resolveCcusageCmd(env: NodeJS.ProcessEnv): string[] {
  const override = env.ROOKERY_CCUSAGE_CMD?.trim();
  if (override) {
    // If it's a JSON array, use it as-is to preserve argument boundaries for paths containing spaces (SEC-7). Otherwise split on whitespace as before.
    if (override.startsWith("[")) {
      try {
        const arr = JSON.parse(override);
        if (Array.isArray(arr) && arr.length > 0 && arr.every((x) => typeof x === "string")) return arr as string[];
      } catch {
        /* JSON parse failed → fall back to whitespace split */
      }
    }
    return override.split(/\s+/);
  }
  // Windows: bunx is a .cmd shim (not directly execFile-able without a shell); bun.exe is a real executable and
  // `bun x` is the bunx equivalent → use it so the no-shell execFile in the usage collector resolves.
  if (process.platform === "win32") {
    const bunExe = path.join(os.homedir(), ".bun", "bin", "bun.exe");
    return [fs.existsSync(bunExe) ? bunExe : "bun", "x", "ccusage@latest"];
  }
  const bunx = path.join(os.homedir(), ".bun", "bin", "bunx");
  return [fs.existsSync(bunx) ? bunx : "bunx", "ccusage@latest"];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const home = env.ROOKERY_HOME?.trim() || path.join(os.homedir(), ".rookery");
  const port = Number.parseInt(env.ROOKERY_PORT ?? "", 10);
  return {
    home,
    dbPath: path.join(home, "rookery.db"),
    pidPath: path.join(home, "daemon.pid"),
    tokenPath: path.join(home, "ws-token"),
    host: env.ROOKERY_HOST?.trim() || "127.0.0.1",
    // Only allow the valid range [0,65535] (negative/out-of-range values crash listen with a RangeError). 0 is a valid value meaning an OS-assigned (ephemeral) port.
    port: Number.isInteger(port) && port >= 0 && port <= 65535 ? port : 8787,
    masterModel: env.ROOKERY_MASTER_MODEL?.trim() || "claude-opus-4-8",
    workerModel: env.ROOKERY_WORKER_MODEL?.trim() || "claude-opus-4-8",
    masterEffort: env.ROOKERY_MASTER_EFFORT?.trim() || "high",
    workerEffort: env.ROOKERY_WORKER_EFFORT?.trim() || "high",
    linearApiKey: env.ROOKERY_LINEAR_API_KEY?.trim() || undefined,
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || undefined,
    fleet: {
      worktreesDir: path.join(home, "worktrees"),
    },
    slack: {
      botToken: env.SLACK_BOT_TOKEN?.trim() || undefined,
      appToken: env.SLACK_APP_TOKEN?.trim() || undefined,
    },
    usage: {
      ccusageCmd: resolveCcusageCmd(env),
    },
  };
}

export function slackEnabled(config: Config): boolean {
  return Boolean(config.slack.botToken && config.slack.appToken);
}

export type AuthMethod = "api-key" | "oauth" | "unknown";

/**
 * Detect how the Claude Agent SDK will authenticate, without requiring an API key.
 * - "api-key": ANTHROPIC_API_KEY is set.
 * - "oauth":   a Claude Code login credentials file exists (the SDK reuses the
 *              ambient session, so no API key is needed).
 * - "unknown": neither detected — the daemon still starts, but turns will fail
 *              unless the user sets a key or runs `claude login`.
 *
 * Best-effort hint only: this is a file-presence heuristic, never a validity
 * check, and it never gates startup. A macOS Keychain-only login can read as
 * "unknown" even though OAuth would work; a stale credentials file can read as
 * "oauth". Either way the daemon boots and only the banner line differs.
 */
export function detectAuth(env: NodeJS.ProcessEnv = process.env): AuthMethod {
  if (env.ANTHROPIC_API_KEY?.trim()) return "api-key";
  const configDir = env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), ".claude");
  if (fs.existsSync(path.join(configDir, ".credentials.json"))) return "oauth";
  return "unknown";
}
