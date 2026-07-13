import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  gcOrphanCodexHomes,
  materializeCodexHome,
  removeCodexHome,
  removeCodexWorkerHome,
  seedCodexHomeFromSource,
  seedCodexWorkerHomeFromSource,
} from "../../src/daemon/codex-home.js";
import type { CodexRuntimeLaunchOptions } from "../../src/daemon/capability-runtime.js";

function managedRuntime(): CodexRuntimeLaunchOptions {
  return {
    revision: "a".repeat(64),
    skills: [{ id: "review-pr", path: "/immutable/runtime/skills/review-pr/SKILL.md" }],
    mcpServers: [
      {
        generatedName: "rookery__team_pack__local",
        config: {
          transport: "stdio",
          command: "/usr/bin/node",
          args: ["/immutable/runtime/launcher.mjs", "/immutable/runtime/local.json"],
          env: { PUBLIC_MODE: "read-only" },
          envVars: ["ROOKERY_CAP_SECRET_LOCAL"],
          enabled: true,
          required: true,
          startupTimeoutSec: 4,
          toolTimeoutSec: 7,
          enabledTools: ["read", "search"],
          disabledTools: ["delete"],
        },
      },
      {
        generatedName: "rookery__team_pack__remote",
        config: {
          transport: "streamable-http",
          url: "https://example.test/mcp",
          httpHeaders: { "X-Public": "yes" },
          envHttpHeaders: { "X-Key": "ROOKERY_CAP_SECRET_HEADER" },
          bearerTokenEnvVar: "ROOKERY_CAP_SECRET_BEARER",
          enabled: true,
        },
      },
    ],
    env: {
      ROOKERY_CAP_SECRET_LOCAL: "actual-secret-local",
      ROOKERY_CAP_SECRET_HEADER: "actual-secret-header",
      ROOKERY_CAP_SECRET_BEARER: "actual-secret-bearer",
    },
    systemPromptAppend: "managed instructions",
    diagnostics: [],
  };
}

describe("materializeCodexHome", () => {
  const dirs: string[] = [];
  function tmp(prefix: string): string {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    dirs.push(d);
    return d;
  }
  afterEach(() => {
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  describe.skipIf(process.platform === "win32")("permissions", () => {
    it("creates the per-session dir 0700 and config.toml 0600", () => {
      const rookeryHome = tmp("rookery-home-");
      const realCodexHome = tmp("real-codex-home-"); // empty — no real config.toml/auth.json
      const dir = materializeCodexHome(rookeryHome, "sess-1", "http://127.0.0.1:8787/mcp/tok-1", { apiKeySet: false, realCodexHome });
      expect(dir).toBe(path.join(rookeryHome, "codex-homes", "sess-1"));
      expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
      const configPath = path.join(dir, "config.toml");
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    });
  });

  it("config.toml contains the mcp_servers.rookery block with the bridge url", () => {
    const rookeryHome = tmp("rookery-home-");
    const realCodexHome = tmp("real-codex-home-");
    const dir = materializeCodexHome(rookeryHome, "sess-1", "http://127.0.0.1:8787/mcp/tok-1", { apiKeySet: false, realCodexHome });
    const content = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
    expect(content).toContain("[mcp_servers.rookery]");
    expect(content).toContain('url = "http://127.0.0.1:8787/mcp/tok-1"');
  });

  it("preserves an existing real config.toml's other tables AND appends the mcp block", () => {
    const rookeryHome = tmp("rookery-home-");
    const realCodexHome = tmp("real-codex-home-");
    fs.writeFileSync(path.join(realCodexHome, "config.toml"), '[model_providers.x]\nbase_url = "https://example.com"\n');
    const dir = materializeCodexHome(rookeryHome, "sess-1", "http://127.0.0.1:8787/mcp/tok-1", { apiKeySet: false, realCodexHome });
    const content = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
    expect(content).toContain("[model_providers.x]");
    expect(content).toContain('base_url = "https://example.com"');
    expect(content).toContain('url = "http://127.0.0.1:8787/mcp/tok-1"');
    // exactly one rookery block
    expect(content.split("[mcp_servers.rookery]")).toHaveLength(2);
  });

  it("strips a pre-existing rookery block from the real config and re-materializing never duplicates it", () => {
    const rookeryHome = tmp("rookery-home-");
    const realCodexHome = tmp("real-codex-home-");
    // Simulate a real config.toml that (somehow) already carries a stale rookery block alongside user content.
    fs.writeFileSync(
      path.join(realCodexHome, "config.toml"),
      '[model_providers.x]\nbase_url = "https://example.com"\n\n[mcp_servers.rookery]\nurl = "http://stale/old"\n',
    );
    const first = materializeCodexHome(rookeryHome, "sess-1", "http://127.0.0.1:8787/mcp/tok-1", { apiKeySet: false, realCodexHome });
    const firstContent = fs.readFileSync(path.join(first, "config.toml"), "utf8");
    expect(firstContent).toContain("[model_providers.x]");
    expect(firstContent.split("[mcp_servers.rookery]")).toHaveLength(2); // exactly one occurrence
    expect(firstContent).toContain('url = "http://127.0.0.1:8787/mcp/tok-1"');
    expect(firstContent).not.toContain("http://stale/old");

    // Re-materialize (simulating turn 2) with a fresh url — still no dupes, latest url wins.
    const second = materializeCodexHome(rookeryHome, "sess-1", "http://127.0.0.1:8787/mcp/tok-2", { apiKeySet: false, realCodexHome });
    const secondContent = fs.readFileSync(path.join(second, "config.toml"), "utf8");
    expect(secondContent).toContain("[model_providers.x]");
    expect(secondContent.split("[mcp_servers.rookery]")).toHaveLength(2);
    expect(secondContent).toContain('url = "http://127.0.0.1:8787/mcp/tok-2"');
    expect(secondContent).not.toContain('tok-1"');
  });

  it("strips a rookery sub-table (e.g. [mcp_servers.rookery.headers]) alongside the main block, preserving unrelated tables (P3-remaining Track A #4)", () => {
    const rookeryHome = tmp("rookery-home-");
    const realCodexHome = tmp("real-codex-home-");
    fs.writeFileSync(
      path.join(realCodexHome, "config.toml"),
      '[model_providers.x]\nbase_url = "https://example.com"\n\n[mcp_servers.rookery]\nurl = "http://stale/old"\n\n[mcp_servers.rookery.headers]\nAuthorization = "Bearer stale"\n',
    );
    const dir = materializeCodexHome(rookeryHome, "sess-1", "http://127.0.0.1:8787/mcp/tok-1", { apiKeySet: false, realCodexHome });
    const content = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
    expect(content).toContain("[model_providers.x]"); // unrelated table preserved
    expect(content).toContain('base_url = "https://example.com"');
    expect(content).not.toContain("[mcp_servers.rookery.headers]"); // sub-table stripped
    expect(content).not.toContain("Bearer stale");
    expect(content).not.toContain("http://stale/old");
    expect(content.split("[mcp_servers.rookery]")).toHaveLength(2); // exactly one clean rookery block appended
    expect(content).toContain('url = "http://127.0.0.1:8787/mcp/tok-1"');
  });

  it("does not strip an unrelated server whose name merely starts with 'rookery' (no dot boundary)", () => {
    const rookeryHome = tmp("rookery-home-");
    const realCodexHome = tmp("real-codex-home-");
    fs.writeFileSync(
      path.join(realCodexHome, "config.toml"),
      '[mcp_servers.rookeryOther]\nurl = "http://keep-me"\n',
    );
    const dir = materializeCodexHome(rookeryHome, "sess-1", "http://127.0.0.1:8787/mcp/tok-1", { apiKeySet: false, realCodexHome });
    const content = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
    expect(content).toContain("[mcp_servers.rookeryOther]");
    expect(content).toContain('url = "http://keep-me"');
  });

  it("falls back to a minimal config when the real config.toml can't be read (e.g. it's a directory, not a file)", () => {
    const rookeryHome = tmp("rookery-home-");
    const realCodexHome = tmp("real-codex-home-");
    fs.mkdirSync(path.join(realCodexHome, "config.toml")); // a directory named config.toml — readFileSync throws EISDIR
    const dir = materializeCodexHome(rookeryHome, "sess-1", "http://127.0.0.1:8787/mcp/tok-1", { apiKeySet: false, realCodexHome });
    const content = fs.readFileSync(path.join(dir, "config.toml"), "utf8");
    expect(content).toContain("[mcp_servers.rookery]");
    expect(content).toContain('url = "http://127.0.0.1:8787/mcp/tok-1"');
  });

  it("symlinks auth.json to the real one when apiKeySet is false and the real auth.json exists", () => {
    const rookeryHome = tmp("rookery-home-");
    const realCodexHome = tmp("real-codex-home-");
    const realAuthPath = path.join(realCodexHome, "auth.json");
    fs.writeFileSync(realAuthPath, '{"token":"real"}');
    const dir = materializeCodexHome(rookeryHome, "sess-1", "http://url", { apiKeySet: false, realCodexHome });
    const authLinkPath = path.join(dir, "auth.json");
    expect(fs.lstatSync(authLinkPath).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(authLinkPath)).toBe(realAuthPath);
    expect(fs.readFileSync(authLinkPath, "utf8")).toBe('{"token":"real"}'); // read-through works
  });

  it("does not create auth.json when apiKeySet is false but the real auth.json is missing", () => {
    const rookeryHome = tmp("rookery-home-");
    const realCodexHome = tmp("real-codex-home-"); // no auth.json
    const dir = materializeCodexHome(rookeryHome, "sess-1", "http://url", { apiKeySet: false, realCodexHome });
    expect(fs.existsSync(path.join(dir, "auth.json"))).toBe(false);
  });

  it("does not symlink auth.json when apiKeySet is true, even if a real auth.json exists", () => {
    const rookeryHome = tmp("rookery-home-");
    const realCodexHome = tmp("real-codex-home-");
    fs.writeFileSync(path.join(realCodexHome, "auth.json"), '{"token":"real"}');
    const dir = materializeCodexHome(rookeryHome, "sess-1", "http://url", { apiKeySet: true, realCodexHome });
    expect(fs.existsSync(path.join(dir, "auth.json"))).toBe(false);
  });

  it("apiKeySet:true clears a STALE auth.json symlink left over from a prior no-key run", () => {
    const rookeryHome = tmp("rookery-home-");
    const realCodexHome = tmp("real-codex-home-");
    fs.writeFileSync(path.join(realCodexHome, "auth.json"), '{"token":"real"}');
    // First materialize with no key: leaves a symlink behind.
    const dir = materializeCodexHome(rookeryHome, "sess-1", "http://url", { apiKeySet: false, realCodexHome });
    const authLinkPath = path.join(dir, "auth.json");
    expect(fs.lstatSync(authLinkPath).isSymbolicLink()).toBe(true);
    // Flip to apiKeySet:true (mid-session no-key→key flip) — the stale symlink must be cleared.
    materializeCodexHome(rookeryHome, "sess-1", "http://url", { apiKeySet: true, realCodexHome });
    expect(fs.existsSync(authLinkPath)).toBe(false);
  });

  it("apiKeySet:true preserves a real (provisioned) auth.json FILE — never unlinks it", () => {
    const rookeryHome = tmp("rookery-home-");
    const realCodexHome = tmp("real-codex-home-");
    const dir = materializeCodexHome(rookeryHome, "sess-1", "http://url", { apiKeySet: true, realCodexHome });
    const authPath = path.join(dir, "auth.json");
    // Simulate codex-backend.ts's openClient() having already provisioned a real auth.json here.
    fs.writeFileSync(authPath, '{"token":"provisioned"}');
    materializeCodexHome(rookeryHome, "sess-1", "http://url", { apiKeySet: true, realCodexHome });
    expect(fs.lstatSync(authPath).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(authPath, "utf8")).toBe('{"token":"provisioned"}');
  });

  it("re-materializing is idempotent (no error, no leftover stale symlink) across repeated calls", () => {
    const rookeryHome = tmp("rookery-home-");
    const realCodexHome = tmp("real-codex-home-");
    fs.writeFileSync(path.join(realCodexHome, "auth.json"), '{"token":"real"}');
    materializeCodexHome(rookeryHome, "sess-1", "http://url-1", { apiKeySet: false, realCodexHome });
    const dir = materializeCodexHome(rookeryHome, "sess-1", "http://url-2", { apiKeySet: false, realCodexHome });
    const authLinkPath = path.join(dir, "auth.json");
    expect(fs.lstatSync(authLinkPath).isSymbolicLink()).toBe(true);
  });

  it("renders managed Codex skills and MCP fields with aliases but never secret values", () => {
    const rookeryHome = tmp("rookery-home-");
    const realCodexHome = tmp("real-codex-home-");
    fs.writeFileSync(path.join(realCodexHome, "config.toml"), 'model = "gpt-test"\n');
    const dir = materializeCodexHome(rookeryHome, "sess-managed", "http://bridge/mcp/token", {
      apiKeySet: false,
      realCodexHome,
      managed: managedRuntime(),
    });
    const content = fs.readFileSync(path.join(dir, "config.toml"), "utf8");

    expect(content).toContain('model = "gpt-test"');
    expect(content).toContain('[[skills.config]]\npath = "/immutable/runtime/skills/review-pr/SKILL.md"\nenabled = true');
    expect(content).toContain("[mcp_servers.rookery__team_pack__local]");
    expect(content).toContain('command = "/usr/bin/node"');
    expect(content).toContain('env_vars = ["ROOKERY_CAP_SECRET_LOCAL"]');
    expect(content).toContain("startup_timeout_sec = 4");
    expect(content).toContain("tool_timeout_sec = 7");
    expect(content).toContain('enabled_tools = ["read","search"]');
    expect(content).toContain("[mcp_servers.rookery__team_pack__remote]");
    expect(content).toContain('bearer_token_env_var = "ROOKERY_CAP_SECRET_BEARER"');
    expect(content).toContain('env_http_headers = { X-Key = "ROOKERY_CAP_SECRET_HEADER" }');
    expect(content).not.toContain("actual-secret-");
    expect(content.split("[mcp_servers.rookery]")).toHaveLength(2);
  });

  it("materializes isolated worker homes without the master bridge", () => {
    const rookeryHome = tmp("rookery-home-");
    const realCodexHome = tmp("real-codex-home-");
    fs.writeFileSync(path.join(realCodexHome, "auth.json"), '{"token":"real"}');
    const first = materializeCodexHome(rookeryHome, "worker-a", undefined, {
      kind: "worker",
      apiKeySet: false,
      realCodexHome,
      managed: managedRuntime(),
    });
    const otherRuntime = managedRuntime();
    otherRuntime.mcpServers = [];
    otherRuntime.skills = [{ id: "other", path: "/immutable/other/SKILL.md" }];
    const second = materializeCodexHome(rookeryHome, "worker-b", undefined, {
      kind: "worker",
      apiKeySet: false,
      realCodexHome,
      managed: otherRuntime,
    });

    expect(first).toBe(path.join(rookeryHome, "codex-homes", "worker-worker-a"));
    expect(second).toBe(path.join(rookeryHome, "codex-homes", "worker-worker-b"));
    expect(first).not.toBe(second);
    const firstConfig = fs.readFileSync(path.join(first, "config.toml"), "utf8");
    const secondConfig = fs.readFileSync(path.join(second, "config.toml"), "utf8");
    expect(firstConfig).toContain("rookery__team_pack__local");
    expect(firstConfig).not.toContain("/immutable/other/SKILL.md");
    expect(secondConfig).toContain("/immutable/other/SKILL.md");
    expect(secondConfig).not.toContain("rookery__team_pack__local");
    expect(firstConfig).not.toContain("[mcp_servers.rookery]");
    expect(secondConfig).not.toContain("[mcp_servers.rookery]");
    expect(fs.lstatSync(path.join(first, "auth.json")).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(second, "auth.json")).isSymbolicLink()).toBe(true);
  });

  it("blocks a managed MCP name that collides with preserved native config", () => {
    const rookeryHome = tmp("rookery-home-");
    const realCodexHome = tmp("real-codex-home-");
    fs.writeFileSync(path.join(realCodexHome, "config.toml"), '[mcp_servers.rookery__team_pack__local]\ncommand = "native"\n');
    expect(() => materializeCodexHome(rookeryHome, "sess-1", "http://bridge", {
      apiKeySet: false,
      realCodexHome,
      managed: managedRuntime(),
    })).toThrow("collides");
    expect(fs.existsSync(path.join(rookeryHome, "codex-homes", "sess-1", "config.toml"))).toBe(false);
  });
});

describe("seedCodexHomeFromSource", () => {
  it("copies the source's entire sessions/ tree (nested rollout included) into the new session's home", () => {
    const rookeryHome = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-home-"));
    try {
      const srcSessions = path.join(rookeryHome, "codex-homes", "src-1", "sessions", "2026", "07", "06");
      fs.mkdirSync(srcSessions, { recursive: true });
      fs.writeFileSync(path.join(srcSessions, "rollout-parent.jsonl"), '{"type":"parent"}\n');

      seedCodexHomeFromSource(rookeryHome, "src-1", "new-1");

      const dst = path.join(rookeryHome, "codex-homes", "new-1", "sessions", "2026", "07", "06", "rollout-parent.jsonl");
      expect(fs.existsSync(dst)).toBe(true);
      expect(fs.readFileSync(dst, "utf8")).toBe('{"type":"parent"}\n');
    } finally {
      fs.rmSync(rookeryHome, { recursive: true, force: true });
    }
  });

  it("copies a Codex worker rollout tree between worker-specific homes", () => {
    const rookeryHome = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-home-"));
    try {
      const srcSessions = path.join(rookeryHome, "codex-homes", "worker-src", "sessions", "2026", "07");
      fs.mkdirSync(srcSessions, { recursive: true });
      fs.writeFileSync(path.join(srcSessions, "rollout.jsonl"), '{"type":"worker"}\n');

      seedCodexWorkerHomeFromSource(rookeryHome, "src", "new");

      const dst = path.join(rookeryHome, "codex-homes", "worker-new", "sessions", "2026", "07", "rollout.jsonl");
      expect(fs.readFileSync(dst, "utf8")).toBe('{"type":"worker"}\n');
    } finally {
      fs.rmSync(rookeryHome, { recursive: true, force: true });
    }
  });

  it("is a no-op (never throws) when the source sessions/ dir is missing", () => {
    const rookeryHome = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-home-"));
    try {
      expect(() => seedCodexHomeFromSource(rookeryHome, "never-existed", "new-1")).not.toThrow();
      expect(fs.existsSync(path.join(rookeryHome, "codex-homes", "new-1"))).toBe(false);
    } finally {
      fs.rmSync(rookeryHome, { recursive: true, force: true });
    }
  });

  it("swallows a copy/mkdir failure (never throws) — honours its documented best-effort contract (finding [21])", () => {
    const rookeryHome = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-home-"));
    try {
      // Source has a real sessions/ tree so we get past the existsSync(src) guard...
      const srcSessions = path.join(rookeryHome, "codex-homes", "src-1", "sessions");
      fs.mkdirSync(srcSessions, { recursive: true });
      fs.writeFileSync(path.join(srcSessions, "rollout.jsonl"), "{}\n");
      // ...but block the destination: codex-homes/new-1 exists as a FILE, so mkdirSync(dirname(dst)) throws.
      // Without the try/catch this propagates and fails the whole codex master fork after thread/fork already succeeded.
      fs.writeFileSync(path.join(rookeryHome, "codex-homes", "new-1"), "not a directory");
      expect(() => seedCodexHomeFromSource(rookeryHome, "src-1", "new-1")).not.toThrow();
    } finally {
      fs.rmSync(rookeryHome, { recursive: true, force: true });
    }
  });
});

describe("removeCodexHome", () => {
  it("removes the per-session dir (best-effort)", () => {
    const rookeryHome = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-home-"));
    try {
      const realCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "real-codex-home-"));
      try {
        const dir = materializeCodexHome(rookeryHome, "sess-1", "http://url", { apiKeySet: false, realCodexHome });
        expect(fs.existsSync(dir)).toBe(true);
        removeCodexHome(rookeryHome, "sess-1");
        expect(fs.existsSync(dir)).toBe(false);
      } finally {
        fs.rmSync(realCodexHome, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(rookeryHome, { recursive: true, force: true });
    }
  });

  it("never throws when the dir does not exist", () => {
    const rookeryHome = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-home-"));
    try {
      expect(() => removeCodexHome(rookeryHome, "never-existed")).not.toThrow();
    } finally {
      fs.rmSync(rookeryHome, { recursive: true, force: true });
    }
  });

  it("removes only the selected worker home", () => {
    const rookeryHome = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-home-"));
    try {
      const realCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), "real-codex-home-"));
      try {
        const first = materializeCodexHome(rookeryHome, "one", undefined, { kind: "worker", apiKeySet: false, realCodexHome });
        const second = materializeCodexHome(rookeryHome, "two", undefined, { kind: "worker", apiKeySet: false, realCodexHome });
        removeCodexWorkerHome(rookeryHome, "one");
        expect(fs.existsSync(first)).toBe(false);
        expect(fs.existsSync(second)).toBe(true);
      } finally {
        fs.rmSync(realCodexHome, { recursive: true, force: true });
      }
    } finally {
      fs.rmSync(rookeryHome, { recursive: true, force: true });
    }
  });
});

describe("gcOrphanCodexHomes", () => {
  it("removes only the codex-homes entries NOT in liveSessionIds", () => {
    const rookeryHome = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-home-"));
    try {
      const base = path.join(rookeryHome, "codex-homes");
      for (const name of ["a", "b", "c"]) {
        fs.mkdirSync(path.join(base, name), { recursive: true });
        fs.writeFileSync(path.join(base, name, "config.toml"), "");
      }
      gcOrphanCodexHomes(rookeryHome, new Set(["a", "c"]));
      expect(fs.existsSync(path.join(base, "a"))).toBe(true);
      expect(fs.existsSync(path.join(base, "b"))).toBe(false); // orphan — not live → removed
      expect(fs.existsSync(path.join(base, "c"))).toBe(true);
    } finally {
      fs.rmSync(rookeryHome, { recursive: true, force: true });
    }
  });

  it("keeps live master and worker homes while collecting both orphan kinds", () => {
    const rookeryHome = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-home-"));
    try {
      const base = path.join(rookeryHome, "codex-homes");
      for (const name of ["session-live", "session-gone", "worker-live", "worker-gone"]) {
        fs.mkdirSync(path.join(base, name), { recursive: true });
      }
      gcOrphanCodexHomes(rookeryHome, new Set(["session-live"]), new Set(["live"]));
      expect(fs.existsSync(path.join(base, "session-live"))).toBe(true);
      expect(fs.existsSync(path.join(base, "session-gone"))).toBe(false);
      expect(fs.existsSync(path.join(base, "worker-live"))).toBe(true);
      expect(fs.existsSync(path.join(base, "worker-gone"))).toBe(false);
    } finally {
      fs.rmSync(rookeryHome, { recursive: true, force: true });
    }
  });

  it("is a no-op when codex-homes does not exist (never throws)", () => {
    const rookeryHome = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-home-"));
    try {
      expect(() => gcOrphanCodexHomes(rookeryHome, new Set(["a"]))).not.toThrow();
      expect(fs.existsSync(path.join(rookeryHome, "codex-homes"))).toBe(false);
    } finally {
      fs.rmSync(rookeryHome, { recursive: true, force: true });
    }
  });

  it("never throws even if readdir itself fails (best-effort)", () => {
    const rookeryHome = fs.mkdtempSync(path.join(os.tmpdir(), "rookery-home-"));
    try {
      // codex-homes exists but as a FILE (not a dir) → readdirSync throws ENOTDIR — must be swallowed.
      fs.writeFileSync(path.join(rookeryHome, "codex-homes"), "not a dir");
      expect(() => gcOrphanCodexHomes(rookeryHome, new Set(["a"]))).not.toThrow();
    } finally {
      fs.rmSync(rookeryHome, { recursive: true, force: true });
    }
  });
});
