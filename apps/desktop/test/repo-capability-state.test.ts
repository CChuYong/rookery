import { describe, expect, it } from "vitest";
import type { CapabilityBinding } from "@daemon/core/capabilities/types.js";
import { repositoryCapabilityState } from "../src/renderer/components/repository-settings/repo-capability-state.js";

function binding(overrides: Partial<CapabilityBinding> = {}): CapabilityBinding {
  return {
    id: "binding-1",
    packInstanceId: "pack-1",
    scopeKind: "repo-local",
    scopeRef: "repo-1",
    audience: { agents: ["master", "worker"], origins: ["ui"] },
    enabled: true,
    createdAt: "t",
    updatedAt: "t",
    ...overrides,
  };
}

describe("repositoryCapabilityState", () => {
  it("defaults an unassigned capability to inherit with both quick agents", () => {
    expect(repositoryCapabilityState([], "repo-1", "pack-1")).toEqual({ mode: "inherit", agents: ["master", "worker"], custom: false });
  });

  it("summarizes canonical UI-only enabled and disabled rows", () => {
    expect(repositoryCapabilityState([binding()], "repo-1", "pack-1")).toEqual({ mode: "enabled", agents: ["master", "worker"], custom: false });
    expect(repositoryCapabilityState([binding({ enabled: false, audience: { agents: ["worker"], origins: ["ui"] } })], "repo-1", "pack-1")).toEqual({ mode: "disabled", agents: ["worker"], custom: false });
  });

  it("ignores Slack-only and Side-only rows because quick settings do not overlap them", () => {
    const rows = [
      binding({ id: "slack", audience: { agents: ["master"], origins: ["slack"] } }),
      binding({ id: "side", audience: { agents: ["side"], origins: ["ui"] } }),
    ];
    expect(repositoryCapabilityState(rows, "repo-1", "pack-1")).toEqual({ mode: "inherit", agents: ["master", "worker"], custom: false });
  });

  it("marks mixed-origin, mixed-agent, and contradictory quick rows as custom", () => {
    expect(repositoryCapabilityState([binding({ audience: { agents: ["master"], origins: ["ui", "slack"] } })], "repo-1", "pack-1").custom).toBe(true);
    expect(repositoryCapabilityState([binding({ audience: { agents: ["master", "side"], origins: ["ui"] } })], "repo-1", "pack-1").custom).toBe(true);
    expect(repositoryCapabilityState([binding({ id: "on", audience: { agents: ["master"], origins: ["ui"] } }), binding({ id: "off", enabled: false, audience: { agents: ["worker"], origins: ["ui"] } })], "repo-1", "pack-1").custom).toBe(true);
  });

  it("does not mix bindings from another repository or pack", () => {
    const rows = [binding({ scopeRef: "repo-2" }), binding({ packInstanceId: "pack-2" })];
    expect(repositoryCapabilityState(rows, "repo-1", "pack-1").mode).toBe("inherit");
  });
});
