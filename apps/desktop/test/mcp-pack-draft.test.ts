import { describe, expect, it } from "vitest";
import {
  compileMcpPackDraft,
  createEmptyMcpServerDraft,
  type McpPackDraft,
} from "../src/renderer/lib/mcp-pack-draft.js";

function draft(overrides: Partial<McpPackDraft> = {}): McpPackDraft {
  return {
    displayName: "Repo Tools",
    id: "repo-tools",
    version: "1.0.0",
    description: "Repository MCP servers",
    repoId: "repo-1",
    agents: ["master", "worker"],
    servers: [{
      ...createEmptyMcpServerDraft("stdio"),
      id: "db",
      command: "npx",
      argsText: "-y\ndb-mcp",
      cwd: "packages/api",
      enabledToolsText: "query, schema\nquery",
      disabledToolsText: "drop",
      required: true,
      publicEntries: [{ rowId: "public-1", target: "LOG_LEVEL", value: "debug" }],
      secretEntries: [{ rowId: "secret-1", target: "TOKEN", key: "db-token", value: "actual-secret-value" }],
    }],
    ...overrides,
  };
}

describe("compileMcpPackDraft", () => {
  it("compiles stdio fields while preserving one argument per non-empty line", () => {
    const result = compileMcpPackDraft(draft({ id: "Repo Tools" }));

    expect(result).toEqual({
      ok: true,
      input: {
        id: "repo-tools",
        displayName: "Repo Tools",
        version: "1.0.0",
        description: "Repository MCP servers",
        repoId: "repo-1",
        agents: ["master", "worker"],
        mcpServers: [{
          id: "db",
          transport: "stdio",
          command: "npx",
          args: ["-y", "db-mcp"],
          cwd: "packages/api",
          env: { LOG_LEVEL: "debug" },
          secretEnv: { TOKEN: { source: "rookery-secret", key: "db-token" } },
          enabledTools: ["query", "schema"],
          disabledTools: ["drop"],
          required: true,
        }],
        secretValues: { "db-token": "actual-secret-value" },
      },
    });
  });

  it("derives a slug id from the display name and omits blank optional fields", () => {
    const server = createEmptyMcpServerDraft("streamable-http");
    server.id = "Docs Search";
    server.url = "https://example.test/mcp";

    const result = compileMcpPackDraft(draft({
      displayName: "My Repo MCPs",
      id: "",
      description: "",
      agents: ["master"],
      servers: [server],
    }));

    expect(result).toEqual({
      ok: true,
      input: {
        id: "my-repo-mcps",
        displayName: "My Repo MCPs",
        version: "1.0.0",
        description: "",
        repoId: "repo-1",
        agents: ["master"],
        mcpServers: [{ id: "docs-search", transport: "streamable-http", url: "https://example.test/mcp" }],
      },
    });
  });

  it("compiles HTTP headers, secret headers, bearer auth, and deduplicated secret values", () => {
    const server = createEmptyMcpServerDraft("streamable-http");
    Object.assign(server, {
      id: "docs",
      url: "https://example.test/mcp",
      publicEntries: [{ rowId: "public-1", target: "X-Scope", value: "repo" }],
      secretEntries: [{ rowId: "secret-1", target: "X-Token", key: "shared-token", value: "secret" }],
      bearerSecretKey: "shared-token",
      bearerSecretValue: "secret",
    });

    const result = compileMcpPackDraft(draft({ servers: [server] }));
    expect(result).toEqual({
      ok: true,
      input: expect.objectContaining({
        mcpServers: [{
          id: "docs",
          transport: "streamable-http",
          url: "https://example.test/mcp",
          headers: { "X-Scope": "repo" },
          secretHeaders: { "X-Token": { source: "rookery-secret", key: "shared-token" } },
          auth: { bearerToken: { source: "rookery-secret", key: "shared-token" } },
        }],
        secretValues: { "shared-token": "secret" },
      }),
    });
  });

  it("supports multiple transports in one pack", () => {
    const http = createEmptyMcpServerDraft("streamable-http");
    http.id = "docs";
    http.url = "https://example.test/mcp";
    const result = compileMcpPackDraft(draft({ servers: [draft().servers[0]!, http] }));

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.mcpServers.map((server) => server.transport)).toEqual(["stdio", "streamable-http"]);
  });

  const requiredCases: Array<[string, Partial<McpPackDraft>]> = [
    ["repo.required", { repoId: "" }],
    ["agents.required", { agents: [] }],
    ["servers.required", { servers: [] }],
    ["displayName.required", { displayName: "", id: "" }],
  ];

  it.each(requiredCases)("reports %s", (code, overrides) => {
    const result = compileMcpPackDraft(draft(overrides));
    expect(result).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code })]) });
  });

  it("rejects duplicate normalized MCP ids and public/secret target collisions", () => {
    const first = draft().servers[0]!;
    const second = { ...createEmptyMcpServerDraft("stdio"), id: "DB", command: "node" };
    const collided = {
      ...first,
      secretEntries: [{ rowId: "secret-2", target: "LOG_LEVEL", key: "log-secret", value: "secret" }],
    };

    const duplicateResult = compileMcpPackDraft(draft({ servers: [first, second] }));
    expect(duplicateResult).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: "server.idDuplicate", serverIndex: 1 })]) });
    const collisionResult = compileMcpPackDraft(draft({ servers: [collided] }));
    expect(collisionResult).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: "server.targetDuplicate", serverIndex: 0 })]) });
  });

  it("rejects missing endpoints and partial secret rows", () => {
    const stdio = createEmptyMcpServerDraft("stdio");
    stdio.id = "db";
    stdio.secretEntries = [{ rowId: "secret-1", target: "TOKEN", key: "db-token", value: "" }];
    const http = createEmptyMcpServerDraft("streamable-http");
    http.id = "docs";

    const result = compileMcpPackDraft(draft({ servers: [stdio, http] }));
    expect(result).toMatchObject({
      ok: false,
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "server.commandRequired", serverIndex: 0 }),
        expect.objectContaining({ code: "server.secretIncomplete", serverIndex: 0 }),
        expect.objectContaining({ code: "server.urlRequired", serverIndex: 1 }),
      ]),
    });
  });

  it("rejects conflicting values assigned to the same secret key", () => {
    const server = draft().servers[0]!;
    server.secretEntries = [
      { rowId: "one", target: "TOKEN_A", key: "shared", value: "first" },
      { rowId: "two", target: "TOKEN_B", key: "shared", value: "second" },
    ];

    const result = compileMcpPackDraft(draft({ servers: [server] }));
    expect(result).toMatchObject({ ok: false, issues: expect.arrayContaining([expect.objectContaining({ code: "secret.valueConflict" })]) });
  });
});
