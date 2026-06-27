import { describe, it, expect } from "vitest";
import { openDb } from "../../src/persistence/db.js";
import { Repositories } from "../../src/persistence/repositories.js";
import { EventBus } from "../../src/core/events.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { FleetOrchestrator } from "../../src/core/fleet-orchestrator.js";
import type { WorkerLike } from "../../src/core/fleet-orchestrator.js";
import { FakeGitOps } from "../../src/core/git-ops.js";
import { startSlack } from "../../src/slack/app.js";
import { fakeQuery } from "../helpers/fake-query.js";

function deps(tokens?: { botToken?: string; appToken?: string }) {
  const repos = new Repositories(openDb(":memory:"));
  const bus = new EventBus();
  const factory = (): WorkerLike => ({ start: () => {}, send: () => {}, stop: async () => {}, status: () => "running", waitUntilSettled: async () => {} });
  const fleet = new FleetOrchestrator({ repos, bus, git: new FakeGitOps(), factory, worktreesDir: "/wt" });
  const sessions = new SessionManager({ repos, bus, queryFn: fakeQuery([]), masterModel: "m", fleet });
  const slackConfig = () => ({ botToken: tokens?.botToken, appToken: tokens?.appToken, cwd: "/work", allowedUsers: [], allowAll: false });
  return { sessions, bus, slackConfig, home: "/home" };
}

describe("startSlack", () => {
  it("returns null when tokens are missing (adapter disabled)", async () => {
    const handle = await startSlack(deps());
    expect(handle).toBeNull();
  });
});
