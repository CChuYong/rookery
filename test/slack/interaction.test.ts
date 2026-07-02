import { describe, it, expect } from "vitest";
import { SlackInteractionBridge, parseSlackThreadKey, makeSlackCanUseTool } from "../../src/slack/interaction.js";
import type { ThreadTarget } from "../../src/slack/types.js";

const target: ThreadTarget = { channel: "C1", threadTs: "100.1", team: "T1" };

function fake() {
  const posts: Array<{ text: string; blocks: unknown[] }> = [];
  const bridge = new SlackInteractionBridge(async (_t: ThreadTarget, m: { text: string; blocks: unknown[] }) => { posts.push(m); });
  return { bridge, posts };
}

// Extract (and parse) the button values from the blocks.
function buttonValues(blocks: unknown[]): Array<{ t: string; d?: string; q?: number; a?: string }> {
  const out: Array<{ t: string; d?: string; q?: number; a?: string }> = [];
  for (const b of blocks as Array<{ type: string; elements?: Array<{ value?: string }> }>) {
    if (b.type === "actions") for (const e of b.elements ?? []) if (e.value) out.push(JSON.parse(e.value));
  }
  return out;
}

describe("SlackInteractionBridge", () => {
  it("approve prompt buttons localize to en", () => {
    const posted: Array<{ text: string; blocks: unknown[] }> = [];
    const bridge = new SlackInteractionBridge(async (_t: ThreadTarget, m: { text: string; blocks: unknown[] }) => { posted.push(m); }, () => "en");
    void bridge.prompt(target, "Bash", { command: "ls" }, { toolUseID: "t1" });
    expect(posted[0]!.text).toBe("🔐 Approval needed: Bash");
    const res = bridge.handleAction(JSON.stringify({ t: "t1", d: "allow" }));
    expect(res?.summary).toBe("✅ Approved");
  });

  it("approve flow: posts approve/deny buttons, resolves allow on approve", async () => {
    const { bridge, posts } = fake();
    const p = bridge.prompt(target, "mcp__fleet__spawn_worker", { repo: "app" }, { toolUseID: "U1" });
    await Promise.resolve();
    expect(posts[0]!.text).toMatch(/승인|spawn_worker/);
    const allow = buttonValues(posts[0]!.blocks).find((v) => v.d === "allow")!;
    bridge.handleAction(JSON.stringify(allow));
    await expect(p).resolves.toEqual({ behavior: "allow" });
  });

  it("approve flow: resolves deny on the deny button", async () => {
    const { bridge, posts } = fake();
    const p = bridge.prompt(target, "mcp__fleet__discard_worker", {}, { toolUseID: "U2" });
    await Promise.resolve();
    const deny = buttonValues(posts[0]!.blocks).find((v) => v.d === "deny")!;
    bridge.handleAction(JSON.stringify(deny));
    const r = await p;
    expect(r.behavior).toBe("deny");
  });

  it("AskUserQuestion: posts option buttons and resolves with answers once every question is answered", async () => {
    const { bridge, posts } = fake();
    const questions = [
      { question: "Format?", header: "Fmt", options: [{ label: "Summary" }, { label: "Detailed" }] },
      { question: "Lang?", header: "Lang", options: [{ label: "KO" }, { label: "EN" }] },
    ];
    const p = bridge.prompt(target, "AskUserQuestion", { questions }, { toolUseID: "U3" });
    await Promise.resolve();
    expect(posts[0]!.text).toMatch(/질문|\?/);
    bridge.handleAction(JSON.stringify({ t: "U3", q: 0, a: "Summary" }));
    // Not all answered yet → unresolved
    bridge.handleAction(JSON.stringify({ t: "U3", q: 1, a: "EN" }));
    const r = (await p) as { behavior: string; updatedInput: { answers: Record<string, string> } };
    expect(r.behavior).toBe("allow");
    expect(r.updatedInput.answers).toEqual({ "Format?": "Summary", "Lang?": "EN" });
  });

  it("resolves deny when the abort signal fires (turn cancelled)", async () => {
    const { bridge } = fake();
    const ac = new AbortController();
    const p = bridge.prompt(target, "mcp__fleet__spawn_worker", {}, { toolUseID: "U4", signal: ac.signal });
    ac.abort();
    const r = await p;
    expect(r.behavior).toBe("deny");
  });

  it("ignores an action for an unknown/already-resolved toolUseID (no throw)", () => {
    const { bridge } = fake();
    expect(() => bridge.handleAction(JSON.stringify({ t: "nope", d: "allow" }))).not.toThrow();
    expect(() => bridge.handleAction("not json")).not.toThrow();
  });

  it("parseSlackThreadKey extracts the thread target (and rejects non-slack keys)", () => {
    expect(parseSlackThreadKey("slack:T1:C1:1782.5")).toEqual({ team: "T1", channel: "C1", threadTs: "1782.5" });
    expect(parseSlackThreadKey("ui:fleet")).toBeNull();
    expect(parseSlackThreadKey(null)).toBeNull();
  });

  it("makeSlackCanUseTool routes a slack session to the bridge, allows when bridge is down, and skips non-slack", async () => {
    const { bridge, posts } = fake();
    const route = makeSlackCanUseTool("slack:T1:C1:1.0", () => bridge)!;
    const p = route("mcp__fleet__spawn_worker", { repo: "app" }, { toolUseID: "U9", signal: new AbortController().signal } as never);
    await Promise.resolve();
    expect(posts.length).toBe(1); // routed to the bridge and posted
    bridge.handleAction(JSON.stringify(buttonValues(posts[0]!.blocks).find((v) => v.d === "allow")!));
    await expect(p).resolves.toEqual({ behavior: "allow" });

    // bridge down → don't block, allow
    const downRoute = makeSlackCanUseTool("slack:T1:C1:2.0", () => null)!;
    await expect(downRoute("x", {}, { toolUseID: "U10" } as never)).resolves.toEqual({ behavior: "allow" });

    // not slack → undefined (not injected = auto-allow)
    expect(makeSlackCanUseTool("ui:fleet", () => bridge)).toBeUndefined();
  });

  it("handleAction returns done+summary so the host can replace the message (remove buttons)", async () => {
    const { bridge, posts } = fake();
    const pa = bridge.prompt(target, "mcp__fleet__spawn_worker", {}, { toolUseID: "D1" });
    await Promise.resolve();
    const allow = buttonValues(posts[0]!.blocks).find((v) => v.d === "allow")!;
    expect(bridge.handleAction(JSON.stringify(allow))).toEqual({ done: true, summary: expect.stringContaining("승인") });
    await pa;
    // Multiple questions: done=true only on the last answer.
    const questions = [{ question: "Q1?", options: [{ label: "A" }] }, { question: "Q2?", options: [{ label: "B" }] }];
    const pq = bridge.prompt(target, "AskUserQuestion", { questions }, { toolUseID: "D2" });
    await Promise.resolve();
    expect(bridge.handleAction(JSON.stringify({ t: "D2", q: 0, a: "A" }))).toEqual({ done: false, summary: "" });
    const last = bridge.handleAction(JSON.stringify({ t: "D2", q: 1, a: "B" }));
    expect(last?.done).toBe(true);
    expect(last?.summary).toContain("Q2?");
    await pq;
  });
});

describe("post failure (card never reached Slack)", () => {
  const target = { channel: "C1", threadTs: "111.222", team: "T1" };

  it("approve: a rejected post resolves pass-through allow instead of hanging the turn", { timeout: 3000 }, async () => {
    const bridge = new SlackInteractionBridge(async () => { throw new Error("channel_not_found"); });
    const r = await bridge.prompt(target, "Bash", { command: "ls" }, { toolUseID: "TF1" });
    expect(r).toEqual({ behavior: "allow" });
    // pending entry cleaned up: a later (impossible) click is an ignored no-op, not a double-resolve
    expect(bridge.handleAction(JSON.stringify({ t: "TF1", d: "allow" }))).toBeUndefined();
  });

  it("ask: a rejected post resolves deny with a delivery-failure message (no invented empty answer)", { timeout: 3000 }, async () => {
    const bridge = new SlackInteractionBridge(async () => { throw new Error("msg_too_long"); });
    const r = await bridge.prompt(target, "AskUserQuestion", { questions: [{ question: "Q?", options: [{ label: "A" }] }] }, { toolUseID: "TF2" });
    expect(r).toMatchObject({ behavior: "deny" });
    expect(bridge.handleAction(JSON.stringify({ t: "TF2", q: 0, a: "A" }))).toBeUndefined();
  });
});
