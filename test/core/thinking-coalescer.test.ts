import { describe, it, expect } from "vitest";
import { ThinkingCoalescer } from "../../src/core/thinking-coalescer.js";

describe("ThinkingCoalescer", () => {
  it("accumulates deltas and flushes coalesced text once, then empties", () => {
    const c = new ThinkingCoalescer();
    expect(c.flush()).toBeNull(); // empty state
    c.push("ab");
    c.push("cd");
    expect(c.flush()).toBe("abcd");
    expect(c.flush()).toBeNull(); // emptied after flush
  });

  it("reset clears the buffer", () => {
    const c = new ThinkingCoalescer();
    c.push("x");
    c.reset();
    expect(c.flush()).toBeNull();
  });
});
