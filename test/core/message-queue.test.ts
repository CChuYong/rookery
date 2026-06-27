import { describe, it, expect } from "vitest";
import { MessageQueue } from "../../src/core/message-queue.js";

async function collect(q: MessageQueue, max: number): Promise<string[]> {
  const out: string[] = [];
  for await (const m of q) {
    const content = m.message.content;
    out.push(typeof content === "string" ? content : JSON.stringify(content));
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
    for await (const m of q) got.push(m.message.content as string);
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

  it("shapes messages as SDK user messages", async () => {
    const q = new MessageQueue();
    q.push("hi");
    q.close();
    const first = (await q[Symbol.asyncIterator]().next()).value;
    expect(first).toMatchObject({
      type: "user",
      message: { role: "user", content: "hi" },
      parent_tool_use_id: null,
    });
  });

  it("ends iteration after close", async () => {
    const q = new MessageQueue();
    q.push("only");
    q.close();
    const got: string[] = [];
    for await (const m of q) got.push(m.message.content as string);
    expect(got).toEqual(["only"]);
  });
});
