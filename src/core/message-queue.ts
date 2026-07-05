type Waiter = (result: IteratorResult<string>) => void;

// Streaming-input queue: an open-ended stream of user input strings. Provider-agnostic — the adapter
// (claude-backend.ts claudeUserMessages) wraps each string into its provider's wire shape.
export class MessageQueue implements AsyncIterable<string> {
  private readonly buffer: string[] = [];
  private readonly waiters: Waiter[] = [];
  private closed = false;

  push(text: string): void {
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

  async *[Symbol.asyncIterator](): AsyncIterator<string> {
    while (true) {
      const buffered = this.buffer.shift();
      if (buffered !== undefined) {
        yield buffered;
        continue;
      }
      if (this.closed) return;
      const result = await new Promise<IteratorResult<string>>((resolve) => {
        this.waiters.push(resolve);
      });
      if (result.done) return;
      yield result.value;
    }
  }
}
