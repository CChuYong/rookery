import { describe, it, expect } from "vitest";
import { EventBus } from "../../src/core/events.js";
import type { CoreEvent } from "../../src/core/events.js";
import { InteractionRegistry } from "../../src/core/interaction-registry.js";

function setup(channel: string) {
  const bus = new EventBus();
  const events: CoreEvent[] = [];
  bus.subscribe(channel, (e) => events.push(e));
  return { bus, events, reg: new InteractionRegistry(bus) };
}

describe("InteractionRegistry", () => {
  it("approve: emits interaction.request, resolves deny on respond, emits resolved", async () => {
    const { events, reg } = setup("s1");
    const cut = reg.canUseToolFor("s1");
    const p = cut("mcp__fleet__spawn_worker", { repo: "app" }, { toolUseID: "R1" } as never);
    await Promise.resolve();
    expect(events.find((e) => e.type === "interaction.request")).toMatchObject({
      type: "interaction.request", sessionId: "s1", requestId: "R1", kind: "approve", toolName: "mcp__fleet__spawn_worker",
    });
    expect(reg.respond("R1", { decision: "deny" })).toEqual({ ok: true });
    await expect(p).resolves.toMatchObject({ behavior: "deny" });
    expect(events.some((e) => e.type === "interaction.resolved" && e.requestId === "R1")).toBe(true);
  });

  it("approve: resolves allow on decision=allow", async () => {
    const { reg } = setup("s1");
    const p = reg.request("s1", "x", {}, { toolUseID: "R1b" });
    await Promise.resolve();
    reg.respond("R1b", { decision: "allow" });
    await expect(p).resolves.toEqual({ behavior: "allow" });
  });

  it("ask: emits questions and resolves with the submitted answers", async () => {
    const { events, reg } = setup("s2");
    const questions = [{ question: "Format?", header: "Fmt", options: [{ label: "Summary" }, { label: "Detailed" }] }];
    const p = reg.request("s2", "AskUserQuestion", { questions }, { toolUseID: "R2" });
    await Promise.resolve();
    expect(events.find((e) => e.type === "interaction.request")).toMatchObject({ kind: "ask", questions });
    reg.respond("R2", { answers: { "Format?": "Summary" } });
    const r = (await p) as { behavior: string; updatedInput: { answers: Record<string, string> } };
    expect(r.behavior).toBe("allow");
    expect(r.updatedInput.answers).toEqual({ "Format?": "Summary" });
  });

  it("abort signal → deny (no hang)", async () => {
    const { reg } = setup("s3");
    const ac = new AbortController();
    const p = reg.request("s3", "x", {}, { toolUseID: "R3", signal: ac.signal });
    ac.abort();
    await expect(p).resolves.toMatchObject({ behavior: "deny" });
  });

  it("abort: resolves deny AND emits interaction.resolved so live cards are retired", async () => {
    const { events, reg } = setup("s3");
    const ac = new AbortController();
    const p = reg.request("s3", "x", {}, { toolUseID: "R3", signal: ac.signal });
    await Promise.resolve();
    ac.abort();
    await expect(p).resolves.toMatchObject({ behavior: "deny" });
    expect(events.find((e) => e.type === "interaction.resolved")).toMatchObject({
      type: "interaction.resolved", sessionId: "s3", requestId: "R3",
    });
    expect(reg.pendingEvents()).toEqual([]); // pending entry cleaned up
  });

  it("respond for an unknown/resolved requestId is a no-op", () => {
    const { reg } = setup("s4");
    expect(reg.respond("nope", { decision: "allow" })).toEqual({ ok: false });
  });

  // Characterization test pinning that the summary string stays byte-identical even after going through the catalog (default ko).
  it("approve → ✅ 승인됨 / deny → 🚫 거부됨 (localized via catalog, default ko)", () => {
    const { bus, reg } = setup("s5");
    const seen: string[] = [];
    bus.subscribe("s5", (e) => { if (e.type === "interaction.resolved") seen.push(e.summary); });
    void reg.request("s5", "Bash", { command: "ls" }, { toolUseID: "t1" });
    reg.respond("t1", { decision: "allow" });
    void reg.request("s5", "Bash", { command: "rm" }, { toolUseID: "t2" });
    reg.respond("t2", { decision: "deny" });
    expect(seen[0]).toBe("✅ 승인됨");
    expect(seen[1]).toBe("🚫 거부됨");
  });

  it("ask answer summary → ✅ 답변 완료 body (localized via catalog, default ko)", () => {
    const { bus, reg } = setup("s6");
    const seen: string[] = [];
    bus.subscribe("s6", (e) => { if (e.type === "interaction.resolved") seen.push(e.summary); });
    void reg.request("s6", "AskUserQuestion", { questions: [{ question: "Format?", header: "Fmt", options: [{ label: "Summary" }] }] }, { toolUseID: "t3" });
    reg.respond("t3", { answers: { "Format?": "Summary", "Tags": ["a", "b"] } });
    expect(seen[0]).toBe("✅ 답변 완료\nFormat? → Summary\nTags → a, b");
  });
});
