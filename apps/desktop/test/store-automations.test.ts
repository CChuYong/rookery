import { describe, it, expect } from "vitest";
import { useStore } from "../src/renderer/store/store.js";

describe("store automations", () => {
  it("setAutomations replaces the list", () => {
    useStore.getState().setAutomations([
      {
        id: "a1",
        name: "n",
        enabled: true,
        trigger: { kind: "cron", cron: "0 3 * * *", timezone: "UTC" },
        action: { kind: "master", prompt: "p", cwd: "/w", sessionMode: "reuse" },
        model: null,
        effort: null,
        permissionMode: null,
        maxTurns: null,
        costBudgetUsd: null,
        lastRunAt: null,
        lastStatus: null,
        lastError: null,
        nextRunAt: null,
        createdAt: "t",
        provider: "claude",
      },
    ]);
    expect(useStore.getState().automations).toHaveLength(1);
  });
});
