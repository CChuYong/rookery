import { describe, it, expect } from "vitest";
import { MessageQueue } from "../../src/core/message-queue.js";

async function collect(q: MessageQueue, max: number): Promise<string[]> {
  const out: string[] = [];
  for await (const text of q) {
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

describe("MessageQueue", () => {
  it("yields messages pushed before iteration", async () => {
    const q = new MessageQueue();
    q.push("first");
    q.push("second");
    q.close();
    const got: string[] = [];
    for await (const text of q) got.push(text);
    expect(got).toEqual(["first", "second"]);
  });

  it("yields a message pushed after the consumer started waiting", async () => {
    const q = new MessageQueue();
    const p = collect(q, 1);
    // push on the next microtask
    await Promise.resolve();
    q.push("late");
    expect(await p).toEqual(["late"]);
  });

  it("yields plain strings (provider-agnostic — the adapter wraps the SDK shape)", async () => {
    const q = new MessageQueue();
    q.push("hi");
    q.close();
    const first = (await q[Symbol.asyncIterator]().next()).value;
    expect(first).toBe("hi");
  });

  it("ends iteration after close", async () => {
    const q = new MessageQueue();
    q.push("only");
    q.close();
    const got: string[] = [];
    for await (const text of q) got.push(text);
    expect(got).toEqual(["only"]);
  });

  it("does not terminate the drain on an empty-string push (!== undefined guard)", async () => {
    const q = new MessageQueue();
    q.push("");
    q.push("after-empty");
    q.close();
    const got: string[] = [];
    for await (const text of q) got.push(text);
    expect(got).toEqual(["", "after-empty"]);
  });
});
