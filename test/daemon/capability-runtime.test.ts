import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CapabilityRuntime, gcCapabilityRuntime } from "../../src/daemon/capability-runtime.js";
import { validateCapabilityPack } from "../../src/core/capabilities/manifest.js";
import type { ResolvedAgentCapabilities } from "../../src/core/capabilities/types.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writePack(root: string): ReturnType<typeof validateCapabilityPack> {
  fs.mkdirSync(path.join(root, "instructions"), { recursive: true });
  fs.writeFileSync(path.join(root, "instructions", "rules.md"), "Use the managed runtime marker RK_SLICE3.\n");
  fs.mkdirSync(path.join(root, "skills", "runtime-check", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "skills", "runtime-check", "SKILL.md"), "---\nname: runtime-check\ndescription: Check the managed runtime\n---\nUse the bundled script.\n");
  fs.writeFileSync(path.join(root, "skills", "runtime-check", "scripts", "check.sh"), "#!/bin/sh\necho runtime-ok\n", { mode: 0o755 });
  fs.mkdirSync(path.join(root, "server"), { recursive: true });
  fs.writeFileSync(path.join(root, "server", "fixture.mjs"), "process.stdin.pipe(process.stdout);\n");
  fs.writeFileSync(path.join(root, "capability.json"), JSON.stringify({
    schemaVersion: 1,
    id: "smoke-pack",
    displayName: "Smoke Pack",
    version: "1.0.0",
    description: "Safe runtime fixture",
    instructions: [{ id: "rules", path: "instructions/rules.md" }],
    skills: [{ id: "runtime-check", path: "skills/runtime-check" }],
    mcpServers: [
      {
        id: "fixture",
        transport: "streamable-http",
        url: "http://127.0.0.1:1/mcp",
        auth: { bearerToken: { source: "rookery-secret", key: "fixture-token" } },
      },
      {
        id: "local",
        transport: "stdio",
        command: "node",
        args: ["fixture.mjs"],
        cwd: "server",
        secretEnv: { TOKEN: { source: "rookery-secret", key: "fixture-token" } },
      },
    ],
  }, null, 2));
  return validateCapabilityPack(root);
}

function resolved(pack: ReturnType<typeof validateCapabilityPack>): ResolvedAgentCapabilities {
  const common = {
    packInstanceId: "instance-1",
    packId: pack.manifest.id,
    digest: pack.digest,
    sourcePath: pack.root,
  };
  return {
    revision: "a".repeat(64),
    blocked: false,
    instructions: [{ ...common, id: "rules", path: "instructions/rules.md" }],
    skills: [{ ...common, id: "runtime-check", path: "skills/runtime-check" }],
    mcpServers: pack.manifest.mcpServers!.map((spec) => ({
      ...common,
      generatedName: `rookery__smoke_pack__${spec.id}`,
      spec,
    })),
  };
}

describe("CapabilityRuntime", () => {
  it("atomically materializes an immutable Claude plugin and keeps secret values environment-only", () => {
    const source = temp("rk-cap-source-");
    const home = temp("rk-cap-home-");
    const pack = writePack(source);
    const runtime = new CapabilityRuntime(home, {
      env: { PATH: "/usr/bin" },
      getSecretValue: (instanceId, key) => instanceId === "instance-1" && key === "fixture-token" ? "actual-secret-value" : undefined,
    });

    const first = runtime.materializeClaude(resolved(pack));
    expect(first.revision).toBe("a".repeat(64));
    expect(first.plugins).toHaveLength(1);
    expect(first.systemPromptAppend).toContain("RK_SLICE3");
    expect(Object.values(first.env)).toContain("actual-secret-value");
    expect(first.env.PATH).toBeUndefined();

    const revisionRoot = path.join(home, "capability-runtime", "a".repeat(64));
    const pluginRoot = first.plugins[0]!.path;
    expect(fs.statSync(revisionRoot).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(pluginRoot, ".claude-plugin", "plugin.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(pluginRoot, ".mcp.json")).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(pluginRoot, "skills", "runtime-check", "scripts", "check.sh")).mode & 0o111).not.toBe(0);

    const mcpConfig = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[]; cwd?: string; env?: Record<string, string> }>;
    };
    const local = mcpConfig.mcpServers.rookery__smoke_pack__local!;
    expect(local.command).toBe(process.execPath);
    expect(local.cwd).toBeUndefined();
    expect(local.args).toHaveLength(2);
    expect(local.args.every((arg) => arg.startsWith(pluginRoot))).toBe(true);
    expect(local.env?.TOKEN).toMatch(/^\$\{ROOKERY_CAP_SECRET_/);
    expect(fs.readFileSync(local.args[0]!, "utf8")).toContain("spawn(config.command");
    expect(JSON.parse(fs.readFileSync(local.args[1]!, "utf8"))).toEqual({
      command: "node",
      args: ["fixture.mjs"],
      cwd: expect.stringMatching(/capability-runtime.*source.*server$/),
    });

    const generated = fs.readdirSync(revisionRoot, { recursive: true })
      .filter((entry): entry is string => typeof entry === "string")
      .flatMap((entry) => {
        const candidate = path.join(revisionRoot, entry);
        return fs.statSync(candidate).isFile() ? [fs.readFileSync(candidate, "utf8")] : [];
      })
      .join("\n");
    expect(generated).toContain("${ROOKERY_CAP_SECRET_");
    expect(generated).not.toContain("actual-secret-value");

    const markerMtime = fs.statSync(path.join(revisionRoot, ".complete.json")).mtimeMs;
    const second = runtime.materializeClaude(resolved(pack));
    expect(second).toEqual(first);
    expect(fs.statSync(path.join(revisionRoot, ".complete.json")).mtimeMs).toBe(markerMtime);
  });

  it("rejects a source changed after trust instead of copying untrusted bytes", () => {
    const source = temp("rk-cap-source-");
    const home = temp("rk-cap-home-");
    const pack = writePack(source);
    fs.writeFileSync(path.join(source, "instructions", "rules.md"), "changed after trust\n");
    const runtime = new CapabilityRuntime(home, { getSecretValue: () => "secret" });

    expect(() => runtime.materializeClaude(resolved(pack))).toThrow("digest changed");
    expect(fs.existsSync(path.join(home, "capability-runtime", "a".repeat(64)))).toBe(false);
  });

  it("materializes Codex skill/MCP artifacts while keeping secret values environment-only", () => {
    const source = temp("rk-cap-source-");
    const home = temp("rk-cap-home-");
    const pack = writePack(source);
    const runtime = new CapabilityRuntime(home, {
      env: { PATH: "/usr/bin" },
      getSecretValue: (instanceId, key) => instanceId === "instance-1" && key === "fixture-token" ? "actual-secret-value" : undefined,
    });

    const launch = runtime.materializeCodex(resolved(pack));
    expect(launch.revision).toBe("a".repeat(64));
    expect(launch.skills).toEqual([{
      id: "runtime-check",
      path: expect.stringMatching(/capability-runtime.*source.*skills[/\\]runtime-check[/\\]SKILL\.md$/),
    }]);
    expect(launch.systemPromptAppend).toContain("RK_SLICE3");
    expect(Object.values(launch.env)).toContain("actual-secret-value");
    expect(launch.env.PATH).toBeUndefined();

    const local = launch.mcpServers.find((server) => server.generatedName === "rookery__smoke_pack__local")!;
    expect(local.config).toMatchObject({
      transport: "stdio",
      command: process.execPath,
      envVars: [expect.stringMatching(/^ROOKERY_CAP_SECRET_/)],
    });
    const args = (local.config as { args: string[] }).args;
    expect(fs.readFileSync(args[0]!, "utf8")).toContain("config.secretEnv");
    expect(JSON.parse(fs.readFileSync(args[1]!, "utf8"))).toEqual({
      command: "node",
      args: ["fixture.mjs"],
      cwd: expect.stringMatching(/capability-runtime.*source.*server$/),
      secretEnv: { TOKEN: expect.stringMatching(/^ROOKERY_CAP_SECRET_/) },
    });

    const remote = launch.mcpServers.find((server) => server.generatedName === "rookery__smoke_pack__fixture")!;
    expect(remote.config).toMatchObject({
      transport: "streamable-http",
      bearerTokenEnvVar: expect.stringMatching(/^ROOKERY_CAP_SECRET_/),
    });

    const revisionRoot = path.join(home, "capability-runtime", "a".repeat(64));
    const generated = fs.readdirSync(revisionRoot, { recursive: true })
      .filter((entry): entry is string => typeof entry === "string")
      .flatMap((entry) => {
        const candidate = path.join(revisionRoot, entry);
        return fs.statSync(candidate).isFile() ? [fs.readFileSync(candidate, "utf8")] : [];
      })
      .join("\n");
    expect(generated).toContain("ROOKERY_CAP_SECRET_");
    expect(generated).not.toContain("actual-secret-value");
    expect(fs.statSync(args[0]!).mode & 0o777).toBe(0o600);
    expect(fs.statSync(args[1]!).mode & 0o777).toBe(0o600);

    const second = runtime.materializeCodex(resolved(pack));
    expect(second).toEqual(launch);
  });

  it("does not create a runtime directory for an empty projection", () => {
    const home = temp("rk-cap-home-");
    const runtime = new CapabilityRuntime(home, { getSecretValue: () => undefined });
    expect(runtime.materializeClaude({
      revision: "empty", blocked: false, instructions: [], skills: [], mcpServers: [],
    })).toEqual({ revision: "empty", plugins: [], env: {}, diagnostics: [] });
    expect(fs.existsSync(path.join(home, "capability-runtime"))).toBe(false);
    expect(runtime.materializeCodex({
      revision: "empty", blocked: false, instructions: [], skills: [], mcpServers: [],
    })).toEqual({ revision: "empty", skills: [], mcpServers: [], env: {}, diagnostics: [] });
  });
});

describe("gcCapabilityRuntime", () => {
  it("keeps only live schema-2 revisions and removes owned stale, invalid, and staging entries", () => {
    const home = temp("rk-cap-gc-");
    const parent = path.join(home, "capability-runtime");
    fs.mkdirSync(parent);
    const live = "a".repeat(64);
    const dead = "b".repeat(64);
    const invalidLive = "c".repeat(64);
    const mismatch = "d".repeat(64);
    for (const revision of [live, dead, invalidLive, mismatch]) fs.mkdirSync(path.join(parent, revision));
    fs.writeFileSync(path.join(parent, live, ".complete.json"), JSON.stringify({ schemaVersion: 2, revision: live }));
    fs.writeFileSync(path.join(parent, dead, ".complete.json"), JSON.stringify({ schemaVersion: 2, revision: dead }));
    fs.writeFileSync(path.join(parent, invalidLive, ".complete.json"), JSON.stringify({ schemaVersion: 1, revision: invalidLive }));
    fs.writeFileSync(path.join(parent, mismatch, ".complete.json"), JSON.stringify({ schemaVersion: 2, revision: live }));
    fs.mkdirSync(path.join(parent, ".tmp-interrupted"));
    fs.writeFileSync(path.join(parent, "keep-not-owned"), "user data");
    fs.writeFileSync(path.join(parent, "e".repeat(64)), "not a directory");

    const result = gcCapabilityRuntime(home, new Set([live, invalidLive, mismatch]));

    expect(result).toEqual({ removed: [".tmp-interrupted", dead, invalidLive, mismatch], kept: [live], failed: [] });
    expect(fs.existsSync(path.join(parent, live))).toBe(true);
    expect(fs.existsSync(path.join(parent, "keep-not-owned"))).toBe(true);
    expect(fs.existsSync(path.join(parent, "e".repeat(64)))).toBe(true);
  });

  it("never follows runtime or marker symlinks while cleaning owned names", () => {
    const home = temp("rk-cap-gc-");
    const parent = path.join(home, "capability-runtime");
    const outside = temp("rk-cap-gc-outside-");
    fs.mkdirSync(parent);
    const linkedRevision = "a".repeat(64);
    fs.writeFileSync(path.join(outside, "preserved"), "outside");
    fs.symlinkSync(outside, path.join(parent, linkedRevision));
    fs.symlinkSync(outside, path.join(parent, ".tmp-linked"));
    const markerLinkedRevision = "b".repeat(64);
    fs.mkdirSync(path.join(parent, markerLinkedRevision));
    const outsideMarker = path.join(outside, "marker.json");
    fs.writeFileSync(outsideMarker, JSON.stringify({ schemaVersion: 2, revision: markerLinkedRevision }));
    fs.symlinkSync(outsideMarker, path.join(parent, markerLinkedRevision, ".complete.json"));

    const result = gcCapabilityRuntime(home, new Set([linkedRevision, markerLinkedRevision]));

    expect(result.removed).toEqual([".tmp-linked", markerLinkedRevision]);
    expect(fs.lstatSync(path.join(parent, linkedRevision)).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(path.join(outside, "preserved"), "utf8")).toBe("outside");
    expect(fs.existsSync(outsideMarker)).toBe(true);
  });

  it("is a no-op when the runtime parent is absent or itself a symlink", () => {
    const home = temp("rk-cap-gc-");
    expect(gcCapabilityRuntime(home, new Set())).toEqual({ removed: [], kept: [], failed: [] });
    const outside = temp("rk-cap-gc-outside-");
    fs.mkdirSync(path.join(outside, "capability-runtime"));
    fs.symlinkSync(path.join(outside, "capability-runtime"), path.join(home, "capability-runtime"));
    expect(gcCapabilityRuntime(home, new Set())).toEqual({ removed: [], kept: [], failed: [] });
  });
});
