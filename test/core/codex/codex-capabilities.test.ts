import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ResolvedAgentCapabilities } from "../../../src/core/capabilities/types.js";
import {
  codexSecretEnvName,
  compileCodexCapabilities,
} from "../../../src/core/codex/codex-capabilities.js";

function fixture(): ResolvedAgentCapabilities {
  const common = {
    packInstanceId: "instance-1",
    packId: "team.pack",
    digest: "d".repeat(64),
    sourcePath: "/mutable/source",
  };
  return {
    revision: "a".repeat(64),
    blocked: false,
    instructions: [{ ...common, id: "rules", path: "instructions/rules.md" }],
    skills: [{ ...common, id: "review-pr", path: "skills/review-pr" }],
    mcpServers: [
      {
        ...common,
        generatedName: "rookery__team_pack__local",
        spec: {
          id: "local",
          transport: "stdio",
          command: "node",
          args: ["server.mjs"],
          cwd: "server",
          env: { PUBLIC_MODE: "read-only" },
          secretEnv: {
            TOKEN: { source: "rookery-secret", key: "token" },
            ACCOUNT: { source: "environment", name: "ACCOUNT_ID" },
          },
          required: true,
          startupTimeoutSec: 4,
          toolTimeoutSec: 7,
          enabledTools: ["read", "search"],
          disabledTools: ["delete"],
        },
      },
      {
        ...common,
        generatedName: "rookery__team_pack__remote",
        spec: {
          id: "remote",
          transport: "streamable-http",
          url: "https://example.test/mcp",
          headers: { "X-Public": "yes" },
          secretHeaders: { "X-Key": { source: "rookery-secret", key: "token" } },
          auth: { bearerToken: { source: "environment", name: "BEARER_TOKEN" } },
          startupTimeoutSec: 9,
        },
      },
    ],
  };
}

describe("compileCodexCapabilities", () => {
  it("lowers skills, instructions, stdio/http MCP, and secret aliases deterministically", () => {
    const sourceRoot = "/runtime/source/instance-1";
    const codexRoot = "/runtime/codex";
    const plan = compileCodexCapabilities(fixture(), () => sourceRoot, codexRoot);
    const tokenAlias = codexSecretEnvName("instance-1", { source: "rookery-secret", key: "token" });
    const accountAlias = codexSecretEnvName("instance-1", { source: "environment", name: "ACCOUNT_ID" });
    const bearerAlias = codexSecretEnvName("instance-1", { source: "environment", name: "BEARER_TOKEN" });

    expect(plan.instructions).toEqual([{
      id: "rules",
      label: "team.pack/rules",
      path: path.join(sourceRoot, "instructions/rules.md"),
    }]);
    expect(plan.skills).toEqual([{
      id: "review-pr",
      path: path.join(sourceRoot, "skills/review-pr/SKILL.md"),
    }]);
    expect(plan.mcpServers).toEqual([
      {
        generatedName: "rookery__team_pack__local",
        config: {
          transport: "stdio",
          command: process.execPath,
          args: [
            path.join(codexRoot, "mcp-runtime/stdio-launcher.mjs"),
            path.join(codexRoot, "mcp-runtime/726f6f6b6572795f5f7465616d5f7061636b5f5f6c6f63616c.json"),
          ],
          env: { PUBLIC_MODE: "read-only" },
          envVars: [accountAlias, tokenAlias].sort(),
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
          envHttpHeaders: { "X-Key": tokenAlias },
          bearerTokenEnvVar: bearerAlias,
          enabled: true,
          startupTimeoutSec: 9,
        },
      },
    ]);
    expect(plan.stdioLaunchers).toEqual([{
      generatedName: "rookery__team_pack__local",
      launcherPath: path.join(codexRoot, "mcp-runtime/stdio-launcher.mjs"),
      descriptorPath: path.join(codexRoot, "mcp-runtime/726f6f6b6572795f5f7465616d5f7061636b5f5f6c6f63616c.json"),
      descriptor: {
        command: "node",
        args: ["server.mjs"],
        cwd: path.join(sourceRoot, "server"),
        secretEnv: { ACCOUNT: accountAlias, TOKEN: tokenAlias },
      },
    }]);
    expect(plan.secretBindings).toEqual([
      { envName: accountAlias, packInstanceId: "instance-1", ref: { source: "environment", name: "ACCOUNT_ID" } },
      { envName: bearerAlias, packInstanceId: "instance-1", ref: { source: "environment", name: "BEARER_TOKEN" } },
      { envName: tokenAlias, packInstanceId: "instance-1", ref: { source: "rookery-secret", key: "token" } },
    ].sort((a, b) => a.envName.localeCompare(b.envName)));
    expect(plan.diagnostics).toEqual([]);
    expect(JSON.stringify(plan)).not.toContain("actual-secret-value");
  });

  it("uses Codex's direct stdio fields when no secret environment remapping is needed", () => {
    const capabilities = fixture();
    capabilities.mcpServers = [{
      ...capabilities.mcpServers[0]!,
      spec: { id: "plain", transport: "stdio", command: "node", args: ["plain.mjs"], cwd: "server", env: { MODE: "safe" } },
      generatedName: "rookery__team_pack__plain",
    }];
    const plan = compileCodexCapabilities(capabilities, () => "/runtime/source", "/runtime/codex");

    expect(plan.stdioLaunchers).toEqual([]);
    expect(plan.mcpServers[0]).toEqual({
      generatedName: "rookery__team_pack__plain",
      config: {
        transport: "stdio",
        command: "node",
        args: ["plain.mjs"],
        cwd: path.join("/runtime/source", "server"),
        env: { MODE: "safe" },
        enabled: true,
      },
    });
  });

  it("rejects blocked manifests, the reserved bridge id, and duplicate generated names", () => {
    expect(() => compileCodexCapabilities({
      revision: "blocked", blocked: true, instructions: [], skills: [], mcpServers: [],
    }, () => "/unused", "/unused")).toThrow("blocked");

    const reserved = fixture();
    reserved.mcpServers = [{ ...reserved.mcpServers[0]!, generatedName: "rookery" }];
    expect(() => compileCodexCapabilities(reserved, () => "/runtime", "/runtime/codex")).toThrow("reserved");

    const duplicate = fixture();
    duplicate.mcpServers[1] = { ...duplicate.mcpServers[1]!, generatedName: duplicate.mcpServers[0]!.generatedName };
    expect(() => compileCodexCapabilities(duplicate, () => "/runtime", "/runtime/codex")).toThrow("duplicate");
  });
});
