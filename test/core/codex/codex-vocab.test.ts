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
  it("prices known models and returns 0 for unknown/absent", () => {
    expect(turnCostUsd("gpt-5.5", { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 })).toBeCloseTo(5.0, 10);
    expect(turnCostUsd("gpt-5.5", { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(0.5, 10);
    expect(turnCostUsd("gpt-5.4-mini", { inputTokens: 0, cachedInputTokens: 0, outputTokens: 1_000_000 })).toBeCloseTo(4.5, 10);
    expect(turnCostUsd("gpt-5.5-pro", { inputTokens: 1_000_000, cachedInputTokens: 1_000_000, outputTokens: 0 })).toBeCloseTo(30.0, 10); // no cache discount tier
    expect(turnCostUsd("some-unknown", { inputTokens: 1_000_000, cachedInputTokens: 0, outputTokens: 0 })).toBe(0);
    expect(turnCostUsd("gpt-5.5", undefined)).toBe(0);
  });
});
