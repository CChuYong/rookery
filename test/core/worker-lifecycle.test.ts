import { describe, it, expect } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import { Worker } from "../../src/core/worker.js";
import { fakeStreamingQuery } from "../helpers/fake-query.js";

// Poll until the condition becomes true (throw on timeout) — the streaming worker only settles to terminal, so idle is observed via status().
async function until(cond: () => boolean, ms = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("until: timeout");
    await new Promise((r) => setTimeout(r, 1));
  }
}

// A finite fakeQuery ends when the script finishes — the generator terminates and the worker becomes done — which differs from the real streaming SDK.
// fakeStreamingQuery stays alive until the input (MessageQueue) closes, so it faithfully reproduces spawn→idle→send→idle→stop.
describe("Worker lifecycle with a streaming query (real SDK fidelity)", () => {
  it("stays idle after each turn (not done) and reaches stopped only on stop()", async () => {
    const repos = new Repositories(openDb(":memory:"));
    repos.createSession({ id: "s1", cwd: "/x" });
    repos.createWorker({ id: "a1", sessionId: "s1", repoPath: "/wt", label: "x", worktreePath: "/wt", branch: "rookery/a1" });
    const bus = new EventBus();
    const queryFn = fakeStreamingQuery((text, turn) => [
      { type: "assistant", text: `reply ${turn}: ${text}` },
      { type: "result", subtype: "success", total_cost_usd: 0, num_turns: 1, session_id: `sdk-${turn}` },
    ]);
    const sub = new Worker({ id: "a1", sessionId: "s1", repoPath: "/wt", label: "x", deps: { repos, bus, queryFn, model: "m" } });

    sub.start("do task");
    await until(() => sub.status() === "idle"); // first turn ends → idle (a finite fake would have become done)
    expect(sub.status()).toBe("idle");

    sub.send("more");
    await until(() => sub.status() === "idle"); // second turn also goes idle — the session stays alive
    expect(sub.status()).toBe("idle");

    await sub.stop();
    expect(sub.status()).toBe("stopped"); // terminates only via stop
  });
});
