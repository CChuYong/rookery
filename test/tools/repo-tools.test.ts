import { describe, it, expect } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { createRepoToolsServer, REPO_SERVER_NAME, REPO_TOOL_NAMES } from "../../src/tools/repo-tools.js";

describe("repo tools", () => {
  it("creates an sdk server with the 4 repo tools", () => {
    const server = createRepoToolsServer(new Repositories(openDb(":memory:")));
    expect(server.type).toBe("sdk");
    expect(server.name).toBe(REPO_SERVER_NAME);
    expect(REPO_TOOL_NAMES).toHaveLength(4);
    expect(REPO_TOOL_NAMES).toContain("mcp__repos__register_repo");
  });
});
