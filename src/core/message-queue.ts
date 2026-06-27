import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";

type Waiter = (result: IteratorResult<SDKUserMessage>) => void;

export class MessageQueue implements AsyncIterable<SDKUserMessage> {
  private readonly buffer: SDKUserMessage[] = [];
  private readonly waiters: Waiter[] = [];
  private closed = false;

  push(text: string): void {
    if (this.closed) throw new Error("MessageQueue is closed");
    // The minimal SDKUserMessage shape required by streaming-input mode.
    // We avoid an `as` assertion — if the SDK (0.x) requires additional mandatory fields, tsc will catch it here.
    const msg: SDKUserMessage = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    };
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: msg, done: false });
    else this.buffer.push(msg);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    let waiter: Waiter | undefined;
    while ((waiter = this.waiters.shift())) {
      // When done:true, value is ignored. Passed as an IteratorReturnResult shape without an assertion.
      waiter({ value: undefined, done: true });
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      const buffered = this.buffer.shift();
      if (buffered) {
        yield buffered;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<SDKUserMessage>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (result.done) return;
      yield result.value;
    }
  }
}
