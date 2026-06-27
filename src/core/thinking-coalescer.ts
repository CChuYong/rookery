// Buffer that accumulates thinking deltas and emits a single coalesced entry at step boundaries.
// Shared by master (master-agent) and worker — live streaming flows as deltas, while persistence uses this coalesced body (to avoid duplication).
export class ThinkingCoalescer {
  private buf = "";

  push(delta: string): void {
    this.buf += delta;
  }

  reset(): void {
    this.buf = "";
  }

  // If there is accumulated content, return it and clear the buffer. Otherwise null.
  flush(): string | null {
    if (!this.buf) return null;
    const text = this.buf;
    this.buf = "";
    return text;
  }
}
