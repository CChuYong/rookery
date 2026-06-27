import { describe, it, expect } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { rememberImpl, recallImpl, createMemoryToolsServer, MEMORY_SERVER_NAME } from "../../src/tools/memory-tools.js";

function repos(): Repositories {
  return new Repositories(openDb(":memory:"));
}

describe("memory tools", () => {
  it("remembers a fact and recalls it", () => {
    const r = repos();
    const saved = rememberImpl(r, { content: "user uses pnpm", tags: "pref" });
    expect(saved.ok).toBe(true);
    const found = recallImpl(r, { query: "pnpm", limit: 5 });
    expect(found.matches.map((m) => m.content)).toEqual(["user uses pnpm"]);
  });

  it("recall returns empty matches when nothing found", () => {
    const r = repos();
    expect(recallImpl(r, { query: "nothing", limit: 5 }).matches).toEqual([]);
  });

  it("creates an SDK MCP server with the right name", () => {
    const server = createMemoryToolsServer(repos());
    expect(server.type).toBe("sdk");
    expect(server.name).toBe(MEMORY_SERVER_NAME);
  });
});
