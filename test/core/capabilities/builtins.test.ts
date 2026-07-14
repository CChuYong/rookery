import { describe, expect, it } from "vitest";
import { claudeCommandCapabilities, rookeryCapabilities } from "../../../src/core/capabilities/builtins.js";

describe("rookeryCapabilities", () => {
  it("describes local side commands and the tool groups composed into master turns", () => {
    const master = rookeryCapabilities({ targetKind: "session" });

    expect(master.entries.map((entry) => entry.id)).toEqual(expect.arrayContaining([
      "rookery.command.btw",
      "rookery.command.capabilities",
      "rookery.command.hooks",
      "rookery.command.mcp",
      "rookery.command.side",
      "rookery.command.skills",
      "rookery.tool.memory",
      "rookery.tool.repos",
      "rookery.tool.fleet",
      "rookery.tool.schedule",
    ]));
    expect(master.entries.find((entry) => entry.id === "rookery.tool.memory")).toMatchObject({
      kind: "tool",
      provider: "rookery",
      source: "Rookery master tools",
      scope: "session",
      state: "applied",
      evidence: "declared",
    });
  });

  it("does not claim master-only tool groups for a worker", () => {
    const worker = rookeryCapabilities({ targetKind: "worker" });

    expect(worker.entries.map((entry) => entry.id)).toEqual([
      "rookery.command.btw",
      "rookery.command.capabilities",
      "rookery.command.hooks",
      "rookery.command.mcp",
      "rookery.command.side",
      "rookery.command.skills",
    ]);
  });

  it("returns stable deterministic output", () => {
    expect(rookeryCapabilities({ targetKind: "session" })).toEqual(rookeryCapabilities({ targetKind: "session" }));
  });
});

describe("claudeCommandCapabilities", () => {
  it("maps commands without losing discovery metadata", () => {
    const result = claudeCommandCapabilities([
      { name: "review", description: "Review changes", argumentHint: "[path]", aliases: ["rv"] },
    ]);

    expect(result.entries).toEqual([
      {
        id: "claude.command.review",
        kind: "command",
        name: "/review",
        description: "Review changes",
        detail: "[path] · aliases: /rv",
        provider: "claude",
        source: "Claude supported commands",
        scope: "session",
        state: "applied",
        evidence: "runtime",
      },
    ]);
    expect(result.diagnostics).toEqual([]);
  });

  it("normalizes names for stable ids and sorts deterministically", () => {
    const result = claudeCommandCapabilities([
      { name: "/Zeta", description: "Z" },
      { name: "alpha", description: "A" },
    ]);

    expect(result.entries.map((entry) => entry.id)).toEqual([
      "claude.command.alpha",
      "claude.command.zeta",
    ]);
  });

  it("keeps an empty successful discovery distinct from a failure diagnostic", () => {
    expect(claudeCommandCapabilities([])).toEqual({ entries: [], diagnostics: [] });
    expect(claudeCommandCapabilities([], new Error("probe timed out"))).toEqual({
      entries: [],
      diagnostics: [{
        id: "claude.commands.discovery",
        source: "Claude supported commands",
        severity: "warning",
        message: "probe timed out",
      }],
    });
  });
});
