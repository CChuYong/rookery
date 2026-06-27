import { describe, it, expect, vi } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { makeSlackTriggerHandler } from "../../src/slack/trigger-source.js";

describe("makeSlackTriggerHandler", () => {
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
});
