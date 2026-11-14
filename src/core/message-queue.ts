import type { AgentInput } from "./image-input.js";
type Waiter = (result: IteratorResult<AgentInput>) => void;

// Streaming-input queue: an open-ended stream of native user inputs. Provider-agnostic — the adapter
// (claude-backend.ts claudeUserMessages) wraps each input into its provider's wire shape.
export class MessageQueue implements AsyncIterable<AgentInput> {
  private readonly buffer: AgentInput[] = [];
  private readonly waiters: Waiter[] = [];
  private closed = false;

  push(text: AgentInput): void {
    if (this.closed) throw new Error("MessageQueue is closed");
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: text, done: false });
    else this.buffer.push(text);
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

  async *[Symbol.asyncIterator](): AsyncIterator<AgentInput> {
    while (true) {
      const buffered = this.buffer.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<AgentInput>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (result.done) return;
      yield result.value;
    }
  }
}
