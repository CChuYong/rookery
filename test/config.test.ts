import { describe, it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig, detectAuth, slackEnabled } from "../src/config.js";

describe("loadConfig", () => {
  it("uses defaults when env is empty", () => {
    const c = loadConfig({});
    expect(c.host).toBe("127.0.0.1");
    expect(c.port).toBe(8787);
    expect(c.masterModel).toBe("claude-opus-4-8");
    expect(c.workerModel).toBe("claude-opus-4-8");
    expect(loadConfig({ ROOKERY_WORKER_MODEL: "claude-sonnet-4-6" }).workerModel).toBe("claude-sonnet-4-6");
    expect(c.dbPath.endsWith("rookery.db")).toBe(true);
    expect(c.pidPath.endsWith("daemon.pid")).toBe(true);
  });

  it("overrides from env", () => {
    const c = loadConfig({ ROOKERY_PORT: "9000", ROOKERY_HOST: "0.0.0.0", ROOKERY_HOME: "/tmp/rookery-x" });
    expect(c.port).toBe(9000);
    expect(c.host).toBe("0.0.0.0");
    expect(c.dbPath).toBe("/tmp/rookery-x/rookery.db");
  });

  it("fleet defaults", () => {
    const c = loadConfig({ ROOKERY_HOME: "/tmp/c" });
    expect(c.fleet.worktreesDir).toBe("/tmp/c/worktrees");
    // The concurrent worker cap (ROOKERY_MAX_WORKERS) was removed — there is no longer any notion of configuring/rejecting it.
  });

  it("clamps an out-of-range or non-numeric ROOKERY_PORT to the default 8787 (0 is valid = ephemeral)", () => {
    expect(loadConfig({ ROOKERY_PORT: "8080" }).port).toBe(8080); // a valid port is kept as-is
    expect(loadConfig({ ROOKERY_PORT: "0" }).port).toBe(0);       // 0 = OS-assigned random port (valid value, test/ephemeral)
    expect(loadConfig({ ROOKERY_PORT: "-1" }).port).toBe(8787);   // negative → prevents a listen crash
    expect(loadConfig({ ROOKERY_PORT: "70000" }).port).toBe(8787); // exceeds 65535
    expect(loadConfig({ ROOKERY_PORT: "abc" }).port).toBe(8787);
  });

  it("parses ROOKERY_CCUSAGE_CMD as a JSON array (preserves spaces) or whitespace-splits (SEC-7)", () => {
    expect(loadConfig({ ROOKERY_CCUSAGE_CMD: '["/my path/bunx","ccusage@latest"]' }).usage.ccusageCmd).toEqual(["/my path/bunx", "ccusage@latest"]);
    expect(loadConfig({ ROOKERY_CCUSAGE_CMD: "bunx ccusage" }).usage.ccusageCmd).toEqual(["bunx", "ccusage"]);
  });

});

describe("detectAuth", () => {
  it("returns 'api-key' when ANTHROPIC_API_KEY is set", () => {
    expect(detectAuth({ ANTHROPIC_API_KEY: "sk-ant-xxx" })).toBe("api-key");
  });

  it("returns 'oauth' when a Claude Code credentials file exists", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-auth-"));
    fs.writeFileSync(path.join(dir, ".credentials.json"), "{}");
    try {
      expect(detectAuth({ CLAUDE_CONFIG_DIR: dir })).toBe("oauth");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns 'unknown' when neither key nor credentials file is present", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-auth-"));
    try {
      expect(detectAuth({ CLAUDE_CONFIG_DIR: dir })).toBe("unknown");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("prefers api-key over an existing oauth credentials file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-auth-"));
    fs.writeFileSync(path.join(dir, ".credentials.json"), "{}");
    try {
      expect(detectAuth({ ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: dir })).toBe("api-key");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("slack config", () => {
  // cwd/allowedUsers/allowAll were moved to settings (DB) — only the tokens remain in config as an env fallback.
  it("loadConfig exposes slack tokens from env", () => {
    const c = loadConfig({ SLACK_BOT_TOKEN: "xoxb-1", SLACK_APP_TOKEN: "xapp-1" });
    expect(c.slack.botToken).toBe("xoxb-1");
    expect(c.slack.appToken).toBe("xapp-1");
  });

  it("slack tokens are undefined when unset", () => {
    const c = loadConfig({});
    expect(c.slack.botToken).toBeUndefined();
    expect(c.slack.appToken).toBeUndefined();
  });

  it("slackEnabled requires both tokens", () => {
    expect(slackEnabled(loadConfig({ SLACK_BOT_TOKEN: "x", SLACK_APP_TOKEN: "y" }))).toBe(true);
    expect(slackEnabled(loadConfig({ SLACK_BOT_TOKEN: "x" }))).toBe(false);
    expect(slackEnabled(loadConfig({}))).toBe(false);
  });
});
