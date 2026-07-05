import { describe, it, expect } from "vitest";
import { mapPermissionMode, sandboxPolicyFor, mapEffort } from "../../../src/core/codex/codex-vocab.js";
import { turnCostUsd } from "../../../src/core/codex/codex-pricing.js";

describe("codex vocab", () => {
  it("maps permission modes to approval/sandbox pairs", () => {
    expect(mapPermissionMode("bypassPermissions")).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access" });
    expect(mapPermissionMode("acceptEdits")).toEqual({ approvalPolicy: "never", sandbox: "workspace-write" });
    expect(mapPermissionMode("default")).toEqual({ approvalPolicy: "never", sandbox: "workspace-write" });
    expect(mapPermissionMode("plan")).toEqual({ approvalPolicy: "never", sandbox: "read-only" });
    expect(mapPermissionMode("unknown-mode")).toEqual({ approvalPolicy: "never", sandbox: "danger-full-access" });
  });
  it("builds per-turn sandbox policy objects", () => {
    expect(sandboxPolicyFor("danger-full-access")).toEqual({ type: "dangerFullAccess" });
    expect(sandboxPolicyFor("read-only")).toEqual({ type: "readOnly", networkAccess: false });
    expect(sandboxPolicyFor("workspace-write")).toMatchObject({ type: "workspaceWrite", writableRoots: [] });
  });
  it("maps effort with max→xhigh and unknown→undefined", () => {
    expect(mapEffort("high")).toBe("high");
    expect(mapEffort("max")).toBe("xhigh");
    expect(mapEffort("weird")).toBeUndefined();
    expect(mapEffort(undefined)).toBeUndefined();
  });
  it("pricing returns 0 with an empty rate table", () => {
    expect(turnCostUsd("gpt-5.5", { inputTokens: 1000, outputTokens: 500 })).toBe(0);
  });
});
