import { describe, expect, it } from "vitest";
import type { CapabilityLibraryEntry, CapabilityPackManifest } from "@daemon/core/capabilities/types.js";
import { catalogKind, catalogSearchText } from "../src/renderer/components/capabilities/catalog.js";

function pack(manifest: CapabilityPackManifest): CapabilityLibraryEntry {
  return {
    instanceId: `pack-${manifest.id}`,
    sourceKind: "rookery-generated",
    sourcePath: `/generated/${manifest.id}`,
    ownerRepoId: null,
    manifest,
    digest: "a".repeat(64),
    status: "untrusted",
    errors: [],
    files: [],
    changes: [],
    secrets: [],
    createdAt: "t",
    updatedAt: "t",
  };
}

const base = { schemaVersion: 1 as const, version: "1.0.0", description: "Useful helper" };

describe("capability catalog projection", () => {
  it("classifies singleton MCP and Skill manifests and treats every mixed manifest as a bundle", () => {
    expect(catalogKind(pack({ ...base, id: "docs", displayName: "Docs", mcpServers: [{ id: "docs", transport: "streamable-http", url: "https://example.test/mcp" }] }))).toBe("mcp");
    expect(catalogKind(pack({ ...base, id: "review", displayName: "Review", skills: [{ id: "review", path: "skill" }] }))).toBe("skill");
    expect(catalogKind(pack({ ...base, id: "mixed", displayName: "Mixed", instructions: [{ id: "rules", path: "rules.md" }], skills: [{ id: "review", path: "skill" }] }))).toBe("bundle");
    expect(catalogKind(pack({ ...base, id: "multi", displayName: "Multi", mcpServers: [{ id: "one", transport: "stdio", command: "one" }, { id: "two", transport: "stdio", command: "two" }] }))).toBe("bundle");
    expect(catalogKind(pack({ ...base, id: "empty", displayName: "Empty" }))).toBe("bundle");
  });

  it("builds deterministic lowercase search text from metadata and item ids", () => {
    const subject = pack({
      ...base,
      id: "team-tools",
      displayName: "Team Tools",
      description: "Issue and Review helpers",
      skills: [{ id: "code-review", path: "skill" }],
      mcpServers: [{ id: "linear", transport: "stdio", command: "linear-mcp" }],
    });

    expect(catalogSearchText(subject)).toBe("team tools team-tools issue and review helpers code-review linear");
  });
});
