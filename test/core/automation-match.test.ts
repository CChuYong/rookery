import { describe, it, expect } from "vitest";
import { matchesSlack, matchesWorker, workerSettleBucket } from "../../src/core/automation-match.js";

const ev = (o: Partial<{ channel: string; userId: string; text: string }> = {}) => ({ channel: "C1", userId: "U1", text: "deploy failed in prod", ...o });

describe("matchesSlack", () => {
  it("empty filters match everything", () => { expect(matchesSlack({ kind: "slack" }, ev())).toBe(true); });
  it("channel filter", () => {
    expect(matchesSlack({ kind: "slack", channels: ["C1"] }, ev())).toBe(true);
    expect(matchesSlack({ kind: "slack", channels: ["C2"] }, ev())).toBe(false);
  });
  it("keyword is case-insensitive substring", () => {
    expect(matchesSlack({ kind: "slack", keyword: "DEPLOY" }, ev())).toBe(true);
    expect(matchesSlack({ kind: "slack", keyword: "rollback" }, ev())).toBe(false);
  });
  it("fromUsers filter", () => {
    expect(matchesSlack({ kind: "slack", fromUsers: ["U1"] }, ev())).toBe(true);
    expect(matchesSlack({ kind: "slack", fromUsers: ["U9"] }, ev({ userId: "U1" }))).toBe(false);
  });
  it("all filters AND together", () => {
    expect(matchesSlack({ kind: "slack", channels: ["C1"], keyword: "deploy", fromUsers: ["U1"] }, ev())).toBe(true);
    expect(matchesSlack({ kind: "slack", channels: ["C1"], keyword: "nope" }, ev())).toBe(false);
  });
});

describe("workerSettleBucket / matchesWorker", () => {
  const wev = (over: Partial<Parameters<typeof matchesWorker>[1]> = {}) =>
    ({ bucket: "stopped" as const, repoName: "app", label: "implement auth", ...over });

  it("buckets: idle→idle, stopped/done→stopped, error/failed/orphaned→failure, live states→undefined", () => {
    expect(workerSettleBucket("idle")).toBe("idle");
    expect(workerSettleBucket("stopped")).toBe("stopped");
    expect(workerSettleBucket("done")).toBe("stopped"); // legacy rows fold into stopped
    expect(workerSettleBucket("error")).toBe("failure");
    expect(workerSettleBucket("failed")).toBe("failure");
    expect(workerSettleBucket("orphaned")).toBe("failure");
    expect(workerSettleBucket("running")).toBeUndefined();
    expect(workerSettleBucket("background")).toBeUndefined(); // NOT settled — bg tasks still run
    expect(workerSettleBucket("provisioning")).toBeUndefined();
  });

  it("default on (absent/empty) = stopped+failure — idle is opt-in", () => {
    expect(matchesWorker({ kind: "worker" }, wev({ bucket: "stopped" }))).toBe(true);
    expect(matchesWorker({ kind: "worker" }, wev({ bucket: "failure" }))).toBe(true);
    expect(matchesWorker({ kind: "worker" }, wev({ bucket: "idle" }))).toBe(false);
    expect(matchesWorker({ kind: "worker", on: [] }, wev({ bucket: "idle" }))).toBe(false); // empty = default
    expect(matchesWorker({ kind: "worker", on: ["idle"] }, wev({ bucket: "idle" }))).toBe(true); // opted in
    expect(matchesWorker({ kind: "worker", on: ["idle"] }, wev({ bucket: "stopped" }))).toBe(false); // explicit on replaces the default
  });

  it("repo filter matches the registered name; unregistered workers never match repo-filtered rules", () => {
    expect(matchesWorker({ kind: "worker", repo: "app" }, wev())).toBe(true);
    expect(matchesWorker({ kind: "worker", repo: "other" }, wev())).toBe(false);
    expect(matchesWorker({ kind: "worker", repo: "app" }, wev({ repoName: undefined }))).toBe(false);
    expect(matchesWorker({ kind: "worker" }, wev({ repoName: undefined }))).toBe(true); // no filter → matches
  });

  it("label filter is a case-insensitive substring", () => {
    expect(matchesWorker({ kind: "worker", label: "IMPLEMENT" }, wev())).toBe(true);
    expect(matchesWorker({ kind: "worker", label: "review" }, wev())).toBe(false);
  });
});
