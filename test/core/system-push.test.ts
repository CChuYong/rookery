import { describe, it, expect } from "vitest";
import { classifySystemPush } from "../../src/core/system-push.js";

describe("classifySystemPush", () => {
  it("commands_changed → commands list (mapped)", () => {
    const out = classifySystemPush({ type: "system", subtype: "commands_changed", commands: [{ name: "review", description: "d", argumentHint: "<x>" }] });
    expect(out).toEqual({ kind: "commands", commands: [{ name: "review", description: "d", argumentHint: "<x>", aliases: undefined }] });
  });

  it("compact_boundary → notice with code + span param + ko text", () => {
    const out = classifySystemPush({ type: "system", subtype: "compact_boundary", compact_metadata: { trigger: "auto", pre_tokens: 84000, post_tokens: 12000 } });
    expect(out).toMatchObject({ kind: "notice", code: "notice.compact", params: { trigger: "auto", span: "84k→12k" } });
    expect((out as { text: string }).text).toContain("압축");
    expect((out as { text: string }).text).toContain("84k→12k");
  });

  it("api_retry and model_refusal_fallback → notice codes", () => {
    // api_retry params are stringified (the SDK may send a number or "?") — assert strings.
    expect(classifySystemPush({ subtype: "api_retry", attempt: 2, max_retries: 5, error: "overloaded" }))
      .toMatchObject({ kind: "notice", code: "notice.apiRetry", params: { attempt: "2", max: "5", error: "overloaded" } });
    const fb = classifySystemPush({ subtype: "model_refusal_fallback", original_model: "claude-fable-5", fallback_model: "claude-opus-4-8" });
    expect(fb).toMatchObject({ kind: "notice", code: "notice.modelFallback", params: { from: "claude-fable-5", to: "claude-opus-4-8" } });
    expect((fb as { text: string }).text).toContain("claude-fable-5 → claude-opus-4-8");
  });

  it("memory_recall / notification → notice; empty are skipped", () => {
    expect(classifySystemPush({ subtype: "memory_recall", memories: [{ path: "/a" }, { path: "/b" }] }))
      .toMatchObject({ kind: "notice", code: "notice.memoryRecall", params: { count: 2 } });
    expect(classifySystemPush({ subtype: "memory_recall", memories: [] })).toBeNull();
    expect(classifySystemPush({ subtype: "notification", text: "Claude needs input", priority: "high" }))
      .toMatchObject({ kind: "notice", code: "notice.notification", params: { text: "Claude needs input" } });
    expect(classifySystemPush({ subtype: "notification", text: "" })).toBeNull();
  });

  it("status → notice only on compact failure; session_state → only requires_action", () => {
    expect(classifySystemPush({ subtype: "status", status: "compacting" })).toBeNull();
    expect(classifySystemPush({ subtype: "status", compact_result: "failed", compact_error: "oom" }))
      .toMatchObject({ kind: "notice", code: "notice.compactFailed", params: { detail: ": oom" } });
    expect(classifySystemPush({ subtype: "session_state_changed", state: "running" })).toBeNull();
    expect(classifySystemPush({ subtype: "session_state_changed", state: "requires_action" }))
      .toMatchObject({ kind: "notice", code: "notice.requiresAction" });
  });

  it("unknown/init system → null (existing handling)", () => {
    expect(classifySystemPush({ subtype: "init" })).toBeNull();
    expect(classifySystemPush({ type: "system" })).toBeNull();
  });
});
