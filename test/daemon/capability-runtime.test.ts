import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CapabilityRuntime } from "../../src/daemon/capability-runtime.js";
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
  fs.writeFileSync(path.join(root, "capability.json"), JSON.stringify({
    schemaVersion: 1,
    id: "smoke-pack",
    displayName: "Smoke Pack",
    version: "1.0.0",
    description: "Safe runtime fixture",
    instructions: [{ id: "rules", path: "instructions/rules.md" }],
    skills: [{ id: "runtime-check", path: "skills/runtime-check" }],
    mcpServers: [{
      id: "fixture",
      transport: "streamable-http",
      url: "http://127.0.0.1:1/mcp",
      auth: { bearerToken: { source: "rookery-secret", key: "fixture-token" } },
    }],
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
    mcpServers: [{
      ...common,
      generatedName: "rookery__smoke_pack__fixture",
      spec: pack.manifest.mcpServers![0]!,
    }],
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

  it("does not create a runtime directory for an empty projection", () => {
    const home = temp("rk-cap-home-");
    const runtime = new CapabilityRuntime(home, { getSecretValue: () => undefined });
    expect(runtime.materializeClaude({
      revision: "empty", blocked: false, instructions: [], skills: [], mcpServers: [],
    })).toEqual({ revision: "empty", plugins: [], env: {}, diagnostics: [] });
    expect(fs.existsSync(path.join(home, "capability-runtime"))).toBe(false);
  });
});
