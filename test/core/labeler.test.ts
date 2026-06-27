import { describe, it, expect } from "vitest";
import { makeLabeler, LABEL_MODEL } from "../../src/core/labeler.js";
import { fakeQuery } from "../helpers/fake-query.js";

describe("makeLabeler", () => {
  it("calls a cheap model with no tools and returns the cleaned label", async () => {
    let opts: { model?: string; allowedTools?: string[]; effort?: string } | undefined;
    const inner = fakeQuery([
      { type: "assistant", text: '"Add rate limiting to checkout."' }, // even when quotes/periods are mixed in
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" },
    ]);
    const qfn = ((input: { options?: typeof opts }) => {
      opts = input.options;
      return inner(input as Parameters<typeof inner>[0]);
    }) as typeof inner;
    const label = await makeLabeler(qfn)("Implement token-bucket rate limiting on the checkout endpoint");
    expect(label).toBe("Add rate limiting to checkout"); // cleaned up
    expect(opts?.model).toBe(LABEL_MODEL); // cheap model
    expect(opts?.allowedTools).toEqual([]); // no tools used for label generation
    expect(opts?.effort).toBeUndefined(); // Haiku does not support effort → must not be sent
  });

  it("returns null on empty task and on query failure (best-effort)", async () => {
    const ok = makeLabeler(fakeQuery([{ type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: "s" }]));
    expect(await ok("   ")).toBeNull(); // an empty task does not even trigger a call
    const boom = makeLabeler(((): never => { throw new Error("nope"); }) as unknown as Parameters<typeof makeLabeler>[0]);
    expect(await boom("real task")).toBeNull(); // null even if the call blows up (placeholder is kept)
  });
});
