import { describe, it, expect, vi } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { makeSlackTriggerHandler } from "../../src/slack/trigger-source.js";

describe("makeSlackTriggerHandler", () => {
  // Minimal enabled slack-trigger automation (no channel/keyword/user filters -> matches any message).
  const mkRule = (id: string) => ({
    id,
    name: id,
    enabled: true,
    trigger: { kind: "slack" as const },
    action: { kind: "master" as const, prompt: "p", cwd: "/w", sessionMode: "reuse" as const },
  });


  it("fires matching enabled slack automations with message vars", async () => {
    const repos = new Repositories(openDb(":memory:"), () => "t");
    repos.createAutomation("a1", { name: "n", trigger: { kind: "slack", channels: ["C1"], keyword: "deploy" }, action: { kind: "master", prompt: "{{message}}", cwd: "/w", sessionMode: "reuse" }, enabled: true });
    repos.createAutomation("a2", { name: "off", trigger: { kind: "slack" }, action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" }, enabled: false });
    repos.createAutomation("a3", { name: "cron", trigger: { kind: "cron", cron: "0 3 * * *", timezone: "UTC" }, action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" }, enabled: true });
    const run = vi.fn(async () => {});
    const handle = makeSlackTriggerHandler({ repos, dispatcher: { run } as any });
    await handle({ channel: "C1", userId: "U1", text: "deploy failed" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![0].id).toBe("a1");
    expect(run.mock.calls[0]![1]).toEqual({ message: "deploy failed", channel: "C1", user: "U1" });
    run.mockClear();
    await handle({ channel: "C2", userId: "U1", text: "deploy failed" }); // wrong channel
    expect(run).not.toHaveBeenCalled();
  });

  it("does not fire disabled slack automations", async () => {
    const repos = new Repositories(openDb(":memory:"), () => "t");
    repos.createAutomation("a1", { name: "off", trigger: { kind: "slack" }, action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" }, enabled: false });
    const run = vi.fn(async () => {});
    const handle = makeSlackTriggerHandler({ repos, dispatcher: { run } as any });
    await handle({ channel: "any", userId: "U1", text: "hello" });
    expect(run).not.toHaveBeenCalled();
  });

  it("does not fire cron automations via slack trigger", async () => {
    const repos = new Repositories(openDb(":memory:"), () => "t");
    repos.createAutomation("a1", { name: "cron", trigger: { kind: "cron", cron: "0 3 * * *", timezone: "UTC" }, action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" }, enabled: true });
    const run = vi.fn(async () => {});
    const handle = makeSlackTriggerHandler({ repos, dispatcher: { run } as any });
    await handle({ channel: "any", userId: "U1", text: "hello" });
    expect(run).not.toHaveBeenCalled();
  });

  it("fires multiple matching automations", async () => {
    const repos = new Repositories(openDb(":memory:"), () => "t");
    repos.createAutomation("a1", { name: "first", trigger: { kind: "slack", channels: ["C1"] }, action: { kind: "master", prompt: "p1", cwd: "/w", sessionMode: "reuse" }, enabled: true });
    repos.createAutomation("a2", { name: "second", trigger: { kind: "slack", channels: ["C1"] }, action: { kind: "master", prompt: "p2", cwd: "/w", sessionMode: "reuse" }, enabled: true });
    const run = vi.fn(async () => {});
    const handle = makeSlackTriggerHandler({ repos, dispatcher: { run } as any });
    await handle({ channel: "C1", userId: "U1", text: "hello" });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("passes userId as user in vars", async () => {
    const repos = new Repositories(openDb(":memory:"), () => "t");
    repos.createAutomation("a1", { name: "n", trigger: { kind: "slack" }, action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" }, enabled: true });
    const run = vi.fn(async () => {});
    const handle = makeSlackTriggerHandler({ repos, dispatcher: { run } as any });
    await handle({ channel: "C1", userId: "U99", text: "test msg" });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0]![1]).toEqual({ message: "test msg", channel: "C1", user: "U99" });
  });

  it("forwards ts/threadTs/team identifiers to dispatcher vars", async () => {
    const repos = new Repositories(openDb(":memory:"), () => "t");
    repos.createAutomation("a1", { name: "n", trigger: { kind: "slack" }, action: { kind: "master", prompt: "{{threadTs}}", cwd: "/w", sessionMode: "reuse" }, enabled: true });
    const run = vi.fn(async () => {});
    const handle = makeSlackTriggerHandler({ repos, dispatcher: { run } as any });
    await handle({ channel: "C1", userId: "U1", text: "hi", ts: "111.222", threadTs: "100.000", team: "T1" });
    expect(run.mock.calls[0]![1]).toEqual({ message: "hi", channel: "C1", user: "U1", ts: "111.222", threadTs: "100.000", team: "T1" });
  });

  it("matching rules dispatch concurrently — a later rule is not delayed behind an earlier rule's full run", async () => {
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => { releaseA = r; });
    const started: string[] = [];
    const dispatcher = { run: async (a: { id: string }) => { started.push(a.id); if (a.id === "a") await gateA; } };
    const rules = [mkRule("a"), mkRule("b")]; // both enabled slack rules matching the message
    const repos = { listAutomations: () => rules, getAutomation: (id: string) => rules.find((r) => r.id === id) };
    const handle = makeSlackTriggerHandler({ repos, dispatcher } as never);
    const p = handle({ channel: "C1", text: "hello" });
    await Promise.resolve(); await Promise.resolve();
    expect(started).toEqual(["a", "b"]); // b started while a is still gated
    releaseA();
    await p;
  });

  it("a rule disabled after the snapshot does not fire (fresh re-read at dispatch)", async () => {
    const ran: string[] = [];
    const dispatcher = { run: async (a: { id: string }) => { ran.push(a.id); } };
    const rule = mkRule("a");
    const repos = { listAutomations: () => [rule], getAutomation: () => ({ ...rule, enabled: false }) };
    await makeSlackTriggerHandler({ repos, dispatcher } as never)({ channel: "C1", text: "hello" });
    expect(ran).toEqual([]);
  });
});
