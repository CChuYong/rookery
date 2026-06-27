import { describe, it, expect } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import {
  wakeupImpl, listImpl, cancelImpl,
  createScheduleToolsServer, SCHEDULE_SERVER_NAME, SCHEDULE_TOOL_NAMES,
} from "../../src/tools/schedule-tools.js";

function ctl(sessionCwd = "/work") {
  const repos = new Repositories(openDb(":memory:"));
  repos.createSession({ id: "s1", cwd: sessionCwd });
  const reconciled: string[] = [];
  let n = 0;
  const c = { repos, reconcile: (id: string) => reconciled.push(id), now: () => new Date("2026-06-23T00:00:00.000Z"), idgen: () => `j${n++}` };
  return { repos, c, reconciled };
}

describe("schedule tools", () => {
  it("server shape: 3 tools under 'schedule'", () => {
    const { c } = ctl();
    const s = createScheduleToolsServer(c, "s1");
    expect(s.name).toBe(SCHEDULE_SERVER_NAME);
    expect(SCHEDULE_TOOL_NAMES).toEqual([
      "mcp__schedule__schedule_wakeup",
      "mcp__schedule__schedule_list",
      "mcp__schedule__schedule_cancel",
    ]);
  });

  it("wakeup: clamps low delay, creates a once automation targeting the session, reconciles", () => {
    const { repos, c, reconciled } = ctl("/work");
    const out = JSON.parse(wakeupImpl(c, "s1", { delaySeconds: 10, reason: "check CI", prompt: "Resume: check the CI run for PR #5." }).text);
    expect(out.clampedDelaySeconds).toBe(60); // clamped up from 10
    expect(out.wasClamped).toBe(true);
    expect(out.scheduledFor).toBe(new Date("2026-06-23T00:01:00.000Z").getTime()); // now + 60s
    expect(reconciled).toContain(out.id);
    const a = repos.getAutomation(out.id)!;
    expect(a.trigger).toEqual({ kind: "once", runAt: "2026-06-23T00:01:00.000Z" });
    expect(a.action).toMatchObject({ kind: "master", targetSessionId: "s1", prompt: "Resume: check the CI run for PR #5.", cwd: "/work", sessionMode: "reuse" });
  });

  it("wakeup: in-range delay is not clamped", () => {
    const { c } = ctl();
    const out = JSON.parse(wakeupImpl(c, "s1", { delaySeconds: 270, reason: "r", prompt: "p" }).text);
    expect(out.clampedDelaySeconds).toBe(270);
    expect(out.wasClamped).toBe(false);
  });

  it("wakeup: clamps high delay to 3600", () => {
    const { c } = ctl();
    const out = JSON.parse(wakeupImpl(c, "s1", { delaySeconds: 99999, reason: "r", prompt: "p" }).text);
    expect(out.clampedDelaySeconds).toBe(3600);
    expect(out.wasClamped).toBe(true);
  });

  it("wakeup: rejects past the per-session pending cap (10)", () => {
    const { c } = ctl();
    for (let i = 0; i < 10; i++) wakeupImpl(c, "s1", { delaySeconds: 100, reason: "r", prompt: "p" });
    const r = wakeupImpl(c, "s1", { delaySeconds: 100, reason: "r", prompt: "p" });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/pending/i);
  });

  it("list: only this session's pending wakeups", () => {
    const { repos, c } = ctl();
    repos.createSession({ id: "s2", cwd: "/other" });
    wakeupImpl(c, "s1", { delaySeconds: 100, reason: "mine", prompt: "p1" });
    wakeupImpl(c, "s2", { delaySeconds: 100, reason: "other", prompt: "p2" });
    const jobs = JSON.parse(listImpl(c, "s1").text).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0].reason).toBe("mine");
  });

  it("cancel: deletes own pending; rejects unknown id and other-session", () => {
    const { repos, c } = ctl();
    repos.createSession({ id: "s2", cwd: "/o" });
    const id = JSON.parse(wakeupImpl(c, "s1", { delaySeconds: 100, reason: "r", prompt: "p" }).text).id;
    expect(cancelImpl(c, "s1", "nope").isError).toBe(true);
    expect(cancelImpl(c, "s2", id).isError).toBe(true); // another session can't cancel mine
    const r = cancelImpl(c, "s1", id);
    expect(r.isError).toBeFalsy();
    expect(repos.getAutomation(id)).toBeUndefined();
  });
});
