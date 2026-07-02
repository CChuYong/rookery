import { describe, it, expect } from "vitest";
import { makeHolder } from "../../src/slack/holder.js";

describe("makeHolder (owner-scoped shared slot)", () => {
  it("set installs; clearIf with the current owner clears", () => {
    const h = makeHolder<{ tag: string }>();
    const a = { tag: "A" };
    expect(h.get()).toBeNull();
    h.set(a);
    expect(h.get()).toBe(a);
    h.clearIf(a);
    expect(h.get()).toBeNull();
  });

  it("a late stale-connection stop does not clobber the live connection's slot (regression: silent auto-allow)", () => {
    const h = makeHolder<{ tag: string }>();
    const a = { tag: "A" }, b = { tag: "B" };
    h.set(a); // connection A comes up
    h.set(b); // retry connection B replaces it
    h.clearIf(a); // A's app.start() resolved late; controller stops the stale handle
    expect(h.get()).toBe(b); // B's holder must survive
  });
});
