import { describe, it, expect } from "vitest";
import { buildHandoffSeed } from "../../src/core/handoff.js";

const ev = (role: string, content: string) => ({ type: "master.message", payload: { kind: "message", role, content } });

describe("buildHandoffSeed", () => {
  it("fences the transcript with the source provider and a continuation instruction", () => {
    const out = buildHandoffSeed([ev("user", "hi"), ev("assistant", "hello")], "claude");
    expect(out).toContain('<prior-conversation from="claude">');
    expect(out).toContain("</prior-conversation>");
    expect(out).toContain("user: hi");
    expect(out).toContain("assistant: hello");
    expect(out).toMatch(/continuing/i);
  });

  it("keeps the NEWEST events within the byte cap and marks older ones truncated", () => {
    const events = Array.from({ length: 40 }, (_, i) => ev("assistant", "x".repeat(100) + `#${i}`));
    const out = buildHandoffSeed(events, "codex", 600);
    expect(out).toContain("#39"); // newest kept
    expect(out).not.toContain("#0 "); // oldest dropped
    expect(out).toMatch(/older .*truncated/i);
  });

  it("renders thinking/tool events compactly (best-effort, not perfect replay)", () => {
    const out = buildHandoffSeed(
      [{ type: "master.thinking", payload: { kind: "thinking", text: "pondering" } }, { type: "master.tool", payload: { kind: "tool", name: "Bash" } }],
      "claude",
    );
    expect(out).toContain("pondering");
    expect(out).toContain("Bash");
  });

  it("returns empty string for no events (caller skips injection)", () => {
    expect(buildHandoffSeed([], "claude")).toBe("");
  });
});
