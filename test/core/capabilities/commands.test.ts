import { describe, expect, it } from "vitest";
import { commandCandidates, rookeryCommandEntries } from "../../../src/core/capabilities/commands.js";
import type { CapabilityEntry, CapabilitySnapshot } from "../../../src/core/capabilities/types.js";

function entry(overrides: Partial<CapabilityEntry> & Pick<CapabilityEntry, "id" | "kind" | "name">): CapabilityEntry {
  return {
    description: "",
    provider: "rookery",
    source: "test",
    scope: "session",
    state: "applied",
    evidence: "runtime",
    ...overrides,
  };
}

function snapshot(provider: "claude" | "codex", entries: CapabilityEntry[]): CapabilitySnapshot {
  return {
    target: { kind: "session", id: "s1", label: "Main", provider, cwd: "/repo" },
    generatedAt: "2026-07-14T00:00:00.000Z",
    entries,
    diagnostics: [],
  };
}

describe("rookeryCommandEntries", () => {
  it("owns all six Rookery client actions in one deterministic registry", () => {
    expect(rookeryCommandEntries("session").map((item) => [item.id, item.name, item.invocation])).toEqual([
      ["rookery.command.btw", "/btw", { type: "client-action", name: "open-panel:btw" }],
      ["rookery.command.capabilities", "/capabilities", { type: "client-action", name: "open-capability-center" }],
      ["rookery.command.hooks", "/hooks", { type: "client-action", name: "open-capability-center:hook" }],
      ["rookery.command.mcp", "/mcp", { type: "client-action", name: "open-capability-center:mcp" }],
      ["rookery.command.side", "/side", { type: "client-action", name: "open-panel:side" }],
      ["rookery.command.skills", "/skills", { type: "client-action", name: "open-capability-center:skill" }],
    ]);
    expect(rookeryCommandEntries("worker")).toEqual(rookeryCommandEntries("session"));
  });
});

describe("commandCandidates", () => {
  it("projects client actions and provider-lowered prompt insertion without exposing dead inventory", () => {
    const candidates = commandCandidates(snapshot("codex", [
      entry({
        id: "managed:pack:skill:release",
        kind: "skill",
        name: "release",
        description: "Ship safely",
        invocation: { type: "prompt", name: "$release" },
        managed: { packInstanceId: "pack", packId: "team", bindingId: "b1", scopeKind: "session", enabled: true },
      }),
      entry({ id: "codex.skill.native", kind: "skill", name: "native", provider: "codex", invocation: { type: "prompt", name: "$native" } }),
      entry({ id: "codex.command.tui", kind: "command", name: "/clear", provider: "codex" }),
      entry({ id: "managed:pack:skill:stale", kind: "skill", name: "stale", state: "pending-reload" }),
    ]));

    expect(candidates.find((candidate) => candidate.name === "release")).toMatchObject({
      id: "managed:pack:skill:release",
      description: "Ship safely",
      action: { type: "insert-prompt", text: "$release" },
    });
    expect(candidates.find((candidate) => candidate.name === "native")?.action).toEqual({ type: "insert-prompt", text: "$native" });
    expect(candidates.some((candidate) => candidate.name === "clear")).toBe(false);
    expect(candidates.some((candidate) => candidate.name === "stale")).toBe(false);
    expect(candidates.find((candidate) => candidate.name === "capabilities")?.action).toEqual({
      type: "open-capability-center",
      tab: "effective",
    });
    expect(candidates.find((candidate) => candidate.name === "skills")?.action).toEqual({
      type: "open-capability-center",
      tab: "effective",
      kind: "skill",
    });
    expect(candidates.find((candidate) => candidate.name === "hooks")?.action).toEqual({
      type: "open-capability-center",
      tab: "effective",
      kind: "hook",
    });
    expect(candidates.find((candidate) => candidate.name === "mcp")?.action).toEqual({
      type: "open-capability-center",
      tab: "effective",
      kind: "mcp",
    });
    expect(candidates.find((candidate) => candidate.name === "btw")?.action).toEqual({ type: "open-panel", panel: "btw" });
    expect(candidates.find((candidate) => candidate.name === "side")?.action).toEqual({ type: "open-panel", panel: "side" });
  });

  it("preserves command hints and aliases and lowers Claude invocation exactly once", () => {
    const candidates = commandCandidates(snapshot("claude", [
      entry({
        id: "claude.command.review",
        kind: "command",
        name: "/review",
        provider: "claude",
        description: "Review changes",
        command: { argumentHint: "[path]", aliases: ["rv", "/inspect"] },
        invocation: { type: "prompt", name: "/review" },
      }),
    ]));

    expect(candidates.find((candidate) => candidate.name === "review")).toEqual({
      id: "claude.command.review",
      name: "review",
      description: "Review changes",
      argumentHint: "[path]",
      aliases: ["rv", "inspect"],
      action: { type: "insert-prompt", text: "/review" },
    });
  });

  it("gives built-ins precedence and drops ambiguous managed skill names", () => {
    const candidates = commandCandidates(snapshot("claude", [
      entry({ id: "claude.command.skills", kind: "command", name: "/skills", provider: "claude", invocation: { type: "prompt", name: "/skills" } }),
      entry({ id: "managed:a:skill:dupe", kind: "skill", name: "dupe", invocation: { type: "prompt", name: "/dupe" }, managed: { packInstanceId: "a", packId: "a", bindingId: "a", scopeKind: "session", enabled: true } }),
      entry({ id: "managed:b:skill:dupe", kind: "skill", name: "DUPE", invocation: { type: "prompt", name: "/DUPE" }, managed: { packInstanceId: "b", packId: "b", bindingId: "b", scopeKind: "session", enabled: true } }),
    ]));

    expect(candidates.filter((candidate) => candidate.name === "skills")).toHaveLength(1);
    expect(candidates.find((candidate) => candidate.name === "skills")?.action.type).toBe("open-capability-center");
    expect(candidates.some((candidate) => candidate.name.toLowerCase() === "dupe")).toBe(false);
    expect(candidates.map((candidate) => candidate.name)).toEqual([...candidates.map((candidate) => candidate.name)].sort());
  });
});
