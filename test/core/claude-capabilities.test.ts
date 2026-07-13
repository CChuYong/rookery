import { describe, expect, it } from "vitest";
import path from "node:path";
import {
  claudeSecretEnvName,
  compileClaudeCapabilities,
} from "../../src/core/claude-capabilities.js";
import type { ResolvedAgentCapabilities } from "../../src/core/capabilities/types.js";

describe("compileClaudeCapabilities", () => {
  it("lowers skills, instructions, stdio/http MCP, and secret references deterministically", () => {
    const capabilities: ResolvedAgentCapabilities = {
      revision: "a".repeat(64),
      blocked: false,
      instructions: [{
        id: "rules", packInstanceId: "instance-1", packId: "team.pack", digest: "d".repeat(64),
        sourcePath: "/original", path: "instructions/rules.md",
      }],
      skills: [{
        id: "review-pr", packInstanceId: "instance-1", packId: "team.pack", digest: "d".repeat(64),
        sourcePath: "/original", path: "skills/review-pr",
      }],
      mcpServers: [
        {
          generatedName: "rookery__team_pack__local",
          packInstanceId: "instance-1", packId: "team.pack", digest: "d".repeat(64), sourcePath: "/original",
          spec: {
            id: "local", transport: "stdio", command: "node", args: ["server.mjs"], cwd: "server",
            env: { PUBLIC_MODE: "read-only" },
            secretEnv: {
              TOKEN: { source: "rookery-secret", key: "token" },
              ACCOUNT: { source: "environment", name: "ACCOUNT_ID" },
            },
            toolTimeoutSec: 7,
          },
        },
        {
          generatedName: "rookery__team_pack__remote",
          packInstanceId: "instance-1", packId: "team.pack", digest: "d".repeat(64), sourcePath: "/original",
          spec: {
            id: "remote", transport: "streamable-http", url: "https://example.test/mcp",
            headers: { "X-Public": "yes" },
            secretHeaders: { "X-Key": { source: "rookery-secret", key: "token" } },
            auth: { bearerToken: { source: "environment", name: "BEARER_TOKEN" } },
            startupTimeoutSec: 4,
          },
        },
      ],
    };
    const sourceRoot = "/runtime/source/instance-1";
    const plan = compileClaudeCapabilities(capabilities, () => sourceRoot);
    const tokenAlias = claudeSecretEnvName("instance-1", { source: "rookery-secret", key: "token" });
    const accountAlias = claudeSecretEnvName("instance-1", { source: "environment", name: "ACCOUNT_ID" });
    const bearerAlias = claudeSecretEnvName("instance-1", { source: "environment", name: "BEARER_TOKEN" });

    expect(plan.instructions).toEqual([{
      id: "rules",
      label: "team.pack/rules",
      path: path.join(sourceRoot, "instructions/rules.md"),
    }]);
    expect(plan.plugins).toHaveLength(1);
    expect(plan.plugins[0]).toMatchObject({
      packInstanceId: "instance-1",
      packId: "team.pack",
      pluginName: expect.stringMatching(/^rookery-team-pack-/),
      skills: [{ id: "review-pr", sourcePath: path.join(sourceRoot, "skills/review-pr") }],
      mcpConfig: {
        mcpServers: {
          rookery__team_pack__local: {
            type: "stdio",
            command: "node",
            args: ["server.mjs"],
            cwd: path.join(sourceRoot, "server"),
            env: {
              PUBLIC_MODE: "read-only",
              TOKEN: `\${${tokenAlias}}`,
              ACCOUNT: `\${${accountAlias}}`,
            },
            timeout: 7_000,
          },
          rookery__team_pack__remote: {
            type: "http",
            url: "https://example.test/mcp",
            headers: {
              "X-Public": "yes",
              "X-Key": `\${${tokenAlias}}`,
              Authorization: `Bearer \${${bearerAlias}}`,
            },
          },
        },
      },
    });
    expect(plan.secretBindings).toEqual([
      { envName: accountAlias, packInstanceId: "instance-1", ref: { source: "environment", name: "ACCOUNT_ID" } },
      { envName: bearerAlias, packInstanceId: "instance-1", ref: { source: "environment", name: "BEARER_TOKEN" } },
      { envName: tokenAlias, packInstanceId: "instance-1", ref: { source: "rookery-secret", key: "token" } },
    ].sort((a, b) => a.envName.localeCompare(b.envName)));
    expect(plan.diagnostics).toEqual([
      "Claude does not support a per-server startup timeout for rookery__team_pack__remote; startupTimeoutSec=4 was not applied.",
    ]);
    expect(JSON.stringify(plan)).not.toContain("actual-secret");
  });

  it("rejects a blocked desired manifest before producing a plugin plan", () => {
    expect(() => compileClaudeCapabilities({
      revision: "blocked", blocked: true, instructions: [], skills: [], mcpServers: [],
    }, () => "/unused")).toThrow("blocked");
  });
});
