import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { materializeCodexHome, removeCodexHome } from "../../src/daemon/codex-home.js";

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

  it("re-materializing is idempotent (no error, no leftover stale symlink) across repeated calls", () => {
    const rookeryHome = tmp("rookery-home-");
    const realCodexHome = tmp("real-codex-home-");
    fs.writeFileSync(path.join(realCodexHome, "auth.json"), '{"token":"real"}');
    materializeCodexHome(rookeryHome, "sess-1", "http://url-1", { apiKeySet: false, realCodexHome });
    const dir = materializeCodexHome(rookeryHome, "sess-1", "http://url-2", { apiKeySet: false, realCodexHome });
    const authLinkPath = path.join(dir, "auth.json");
    expect(fs.lstatSync(authLinkPath).isSymbolicLink()).toBe(true);
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
});
