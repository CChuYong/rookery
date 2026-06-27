import { describe, it, expect } from "vitest";
import { EventBus } from "../../src/core/events.js";
import type { CoreEvent } from "../../src/core/events.js";
import { ThreadRegistry } from "../../src/slack/thread-registry.js";
import { SlackThreadReporter } from "../../src/slack/reporter.js";
import type { SlackClient, ChatStreamArgs, ChatStreamerLike, AppendPayload } from "../../src/slack/types.js";

function recClient() {
  const appends: string[] = [];
  const client: SlackClient = {
    chatStream(_args: ChatStreamArgs): ChatStreamerLike {
      return {
        async append(p: AppendPayload) {
          if ("chunks" in p) {
            for (const c of p.chunks) if (c.type === "markdown_text") appends.push(c.text);
          } else {
            appends.push(p.markdown_text);
          }
        },
        async stop() {},
      };
    },
    chat: { async postMessage() {} },
  };
  return { client, appends };
}
const target = { channel: "C1", threadTs: "1.1", team: "T1" };
const msg = (c: string): CoreEvent => ({ type: "master.message", sessionId: "s1", role: "assistant", content: c });

describe("ThreadRegistry", () => {
  it("creates one reporter per session and forwards bus events to it", async () => {
    const bus = new EventBus();
    const { client, appends } = recClient();
    const reg = new ThreadRegistry(bus);
    let made = 0;
    const make = () => { made++; return new SlackThreadReporter(client, target); };
    const r1 = reg.ensure("s1", make);
    const r2 = reg.ensure("s1", make); // reuse
    expect(r1).toBe(r2);
    expect(made).toBe(1);
    bus.emit(msg("hi"));
    await r1.idle();
    expect(appends).toEqual(["hi"]);
  });

  it("evicts the least-recently-used reporter beyond the cap (no unbounded leak)", async () => {
    const bus = new EventBus();
    const { client, appends } = recClient();
    const reg = new ThreadRegistry(bus, 2); // cap 2
    const rA = reg.ensure("sA", () => new SlackThreadReporter(client, target));
    reg.ensure("sB", () => new SlackThreadReporter(client, target));
    reg.ensure("sC", () => new SlackThreadReporter(client, target)); // evict the oldest, sA
    bus.emit({ type: "master.message", sessionId: "sA", role: "assistant", content: "to-A" });
    await rA.idle();
    expect(appends).toEqual([]); // sA was unsubscribed, so events are no longer delivered
  });

  it("disposeAll unsubscribes so further events are not delivered", async () => {
    const bus = new EventBus();
    const { client, appends } = recClient();
    const reg = new ThreadRegistry(bus);
    const r = reg.ensure("s1", () => new SlackThreadReporter(client, target));
    reg.disposeAll();
    bus.emit(msg("after"));
    await r.idle();
    expect(appends).toEqual([]);
  });
});
