import { describe, expect, it } from "vitest";
import { capabilityTargetKey, defaultCapabilityPreview } from "../src/renderer/components/capabilities/capability-target.js";

describe("capability target helpers", () => {
  it("creates the cold default and stable keys for every target class", () => {
    expect(defaultCapabilityPreview()).toEqual({ kind: "rookery", provider: "claude", agent: "master" });
    expect(capabilityTargetKey({ kind: "rookery", provider: "claude", agent: "master" })).toBe("rookery:claude:master");
    expect(capabilityTargetKey({ kind: "repo", id: "repo-1", provider: "codex", agent: "worker" })).toBe("repo:repo-1:codex:worker");
    expect(capabilityTargetKey({ kind: "session", id: "session-1" })).toBe("session:session-1");
    expect(capabilityTargetKey({ kind: "worker", id: "worker-1" })).toBe("worker:worker-1");
  });
});
