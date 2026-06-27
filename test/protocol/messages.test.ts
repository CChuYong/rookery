import { describe, it, expect } from "vitest";
import { parseClientMessage, serializeServerMessage, clientMessageSchema } from "../../src/protocol/messages.js";
import type { ServerMessage } from "../../src/protocol/messages.js";

describe("protocol v2 client messages", () => {
  it("settings.set: accepts null (reset-to-default) and validates effort against the enum", () => {
    // null → reset to default (only reachable if the schema is nullable)
    expect(() => parseClientMessage(JSON.stringify({ type: "settings.set", reqId: "q", settings: { masterModel: null } }))).not.toThrow();
    // valid effort passes
    expect(() => parseClientMessage(JSON.stringify({ type: "settings.set", reqId: "q", settings: { masterEffort: "high" } }))).not.toThrow();
    // invalid effort is rejected (previously it passed and was then silently dropped every turn)
    expect(() => parseClientMessage(JSON.stringify({ type: "settings.set", reqId: "q", settings: { workerEffort: "HIGH" } }))).toThrow();
  });

  it("parses fleet + repos + history requests with reqId", () => {
    expect(parseClientMessage(JSON.stringify({ type: "fleet.list", reqId: "r1" }))).toMatchObject({ type: "fleet.list", reqId: "r1" });
    expect(parseClientMessage(JSON.stringify({ type: "fleet.diff", reqId: "r2", id: "a1" }))).toMatchObject({ type: "fleet.diff", id: "a1" });
    expect(parseClientMessage(JSON.stringify({ type: "fleet.stop", reqId: "r3", id: "a1" }))).toMatchObject({ type: "fleet.stop" });
    expect(parseClientMessage(JSON.stringify({ type: "fleet.subscribe" }))).toMatchObject({ type: "fleet.subscribe" });
    expect(parseClientMessage(JSON.stringify({ type: "repos.register", reqId: "r4", name: "p", path: "/p", description: "d" }))).toMatchObject({ type: "repos.register", name: "p" });
    expect(parseClientMessage(JSON.stringify({ type: "session.history", reqId: "r5", sessionId: "s1" }))).toMatchObject({ type: "session.history", sessionId: "s1" });
  });
  it("parses worker.interrupt (id required, reqId optional)", () => {
    expect(parseClientMessage(JSON.stringify({ type: "worker.interrupt", id: "a1" }))).toMatchObject({ type: "worker.interrupt", id: "a1" });
    expect(parseClientMessage(JSON.stringify({ type: "worker.interrupt", id: "a1", reqId: "q1" }))).toMatchObject({ type: "worker.interrupt", id: "a1", reqId: "q1" });
    expect(() => parseClientMessage(JSON.stringify({ type: "worker.interrupt" }))).toThrow(); // id missing → rejected
  });
  it("fleet.spawn parses without a task (task-less spawn)", () => {
    expect(clientMessageSchema.safeParse({ type: "fleet.spawn", reqId: "r", repo: "app" }).success).toBe(true);
    expect(clientMessageSchema.safeParse({ type: "fleet.spawn", reqId: "r", repo: "app", task: "do x" }).success).toBe(true);
  });

  it("rejects unknown type", () => {
    expect(() => parseClientMessage(JSON.stringify({ type: "nope" }))).toThrow();
  });
});

describe("automation protocol messages", () => {
  it("automation.create: valid cron/master create parses", () => {
    const ok = {
      type: "automation.create", reqId: "q",
      automation: {
        name: "n",
        trigger: { kind: "cron", cron: "0 3 * * *", timezone: "UTC" },
        action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" },
      },
    };
    expect(() => parseClientMessage(JSON.stringify(ok))).not.toThrow();
  });

  it("automation.create: invalid cron expression is rejected", () => {
    const invalid = {
      type: "automation.create", reqId: "q",
      automation: {
        name: "n",
        trigger: { kind: "cron", cron: "99 99 * * *", timezone: "UTC" },
        action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" },
      },
    };
    expect(() => parseClientMessage(JSON.stringify(invalid))).toThrow();
  });

  it("automation.create: slack/worker create parses", () => {
    const ok = {
      type: "automation.create", reqId: "q",
      automation: {
        name: "slack-worker",
        trigger: { kind: "slack", channels: ["#general"], keyword: "deploy" },
        action: { kind: "worker", repo: "app", task: "run tests" },
      },
    };
    expect(() => parseClientMessage(JSON.stringify(ok))).not.toThrow();
  });

  it("automation.run / set_enabled parse", () => {
    expect(() => parseClientMessage(JSON.stringify({ type: "automation.run", reqId: "q", id: "s1" }))).not.toThrow();
    expect(() => parseClientMessage(JSON.stringify({ type: "automation.set_enabled", reqId: "q", id: "s1", enabled: true }))).not.toThrow();
  });

  it("automation.run accepts optional vars (and still parses without them)", () => {
    expect(clientMessageSchema.safeParse({ type: "automation.run", reqId: "r", id: "a1" }).success).toBe(true);
    const withVars = clientMessageSchema.safeParse({ type: "automation.run", reqId: "r", id: "a1", vars: { message: "hi", channel: "C1" } });
    expect(withVars.success).toBe(true);
    if (withVars.success && withVars.data.type === "automation.run") expect(withVars.data.vars?.message).toBe("hi");
  });

  it("old schedule.* types are rejected", () => {
    expect(() => parseClientMessage(JSON.stringify({ type: "schedule.list", reqId: "q" }))).toThrow();
    expect(() => parseClientMessage(JSON.stringify({ type: "schedule.create", reqId: "q", job: {} }))).toThrow();
  });

  it("automation.create: permissionMode + maxTurns are accepted, validated, and optional", () => {
    const base = {
      type: "automation.create", reqId: "q",
      automation: {
        name: "n",
        trigger: { kind: "cron", cron: "0 3 * * *", timezone: "UTC" },
        action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" },
      },
    };
    // valid permissionMode + maxTurns
    expect(() => parseClientMessage(JSON.stringify({ ...base, automation: { ...base.automation, permissionMode: "plan", maxTurns: 5 } }))).not.toThrow();
    // both omitted (optional)
    expect(() => parseClientMessage(JSON.stringify(base))).not.toThrow();
    // null is allowed (explicit clear)
    expect(() => parseClientMessage(JSON.stringify({ ...base, automation: { ...base.automation, permissionMode: null, maxTurns: null } }))).not.toThrow();
    // invalid permissionMode string
    expect(() => parseClientMessage(JSON.stringify({ ...base, automation: { ...base.automation, permissionMode: "lol" } }))).toThrow();
    // maxTurns=0 rejected (must be positive)
    expect(() => parseClientMessage(JSON.stringify({ ...base, automation: { ...base.automation, maxTurns: 0 } }))).toThrow();
    // maxTurns=-1 rejected
    expect(() => parseClientMessage(JSON.stringify({ ...base, automation: { ...base.automation, maxTurns: -1 } }))).toThrow();
  });
});

describe("protocol", () => {
  it("parses a valid session.send", () => {
    const msg = parseClientMessage(JSON.stringify({ type: "session.send", sessionId: "s1", text: "hi" }));
    expect(msg).toEqual({ type: "session.send", sessionId: "s1", text: "hi" });
  });

  it("session.send accepts optional clientMsgId", () => {
    const ok = parseClientMessage(JSON.stringify({ type: "session.send", sessionId: "s1", text: "hi", clientMsgId: "c1" }));
    expect(ok.type).toBe("session.send");
    const ok2 = parseClientMessage(JSON.stringify({ type: "session.send", sessionId: "s1", text: "hi" })); // passes even when absent
    expect(ok2.type).toBe("session.send");
  });

  it("parses session.create with optional cwd", () => {
    expect(parseClientMessage(JSON.stringify({ type: "session.create" }))).toEqual({
      type: "session.create",
    });
  });

  it("parses session.open with an external key", () => {
    expect(parseClientMessage(JSON.stringify({ type: "session.open", key: "thread-42" }))).toEqual({
      type: "session.open",
      key: "thread-42",
    });
  });

  it("throws when session.open is missing key", () => {
    expect(() => parseClientMessage(JSON.stringify({ type: "session.open" }))).toThrow();
  });

  it("throws on invalid JSON", () => {
    expect(() => parseClientMessage("{not json")).toThrow();
  });

  it("throws on unknown type", () => {
    expect(() => parseClientMessage(JSON.stringify({ type: "nope" }))).toThrow();
  });

  it("throws when required field missing", () => {
    expect(() => parseClientMessage(JSON.stringify({ type: "session.send", sessionId: "s1" }))).toThrow();
  });

  it("serializes server messages round-trip", () => {
    const msg: ServerMessage = {
      type: "event",
      event: { type: "master.message", sessionId: "s1", role: "assistant", content: "hello" },
    };
    expect(JSON.parse(serializeServerMessage(msg))).toEqual(msg);
  });
});
