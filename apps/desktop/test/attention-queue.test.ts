import { describe, it, expect } from "vitest";
import { buildAttentionItems, type AttentionInputs } from "../src/renderer/lib/attention-queue.js";
import type { FleetRow, LogItem } from "../src/renderer/store/reduce.js";

const worker = (id: string, status: string, over: Partial<FleetRow> = {}): FleetRow =>
  ({ id, label: `w-${id}`, repoPath: "/r", status, branch: null, model: null, permissionMode: "bypassPermissions", ticketKey: null, ticketUrl: null, ...over }) as FleetRow;

const interaction = (requestId: string, over: Partial<Extract<LogItem, { kind: "interaction" }>> = {}): LogItem =>
  ({ kind: "interaction", requestId, mode: "ask", questions: [{ question: "Deploy?", header: "q", options: [], multiSelect: false }], ...over }) as LogItem;

function inputs(over: Partial<AttentionInputs> = {}): AttentionInputs {
  return {
    logsBySession: {},
    liveInteractionIds: new Set(),
    fleet: {},
    automations: [],
    attention: {},
    sessionAttention: {},
    sessions: [{ id: "s1", label: "내 세션" }],
    active: { sessionId: null, workerId: null, overlay: null },
    ...over,
  };
}

describe("buildAttentionItems", () => {
  it("ranks tiers: interactions first, then failures, then review-pending", () => {
    const { items } = buildAttentionItems(
      inputs({
        logsBySession: { s1: [interaction("r1")] },
        liveInteractionIds: new Set(["r1"]),
        fleet: { w1: worker("w1", "error"), w2: worker("w2", "stopped") },
        attention: { w2: true },
        automations: [{ id: "a1", name: "nightly", lastStatus: "error", lastRunAt: "t1", lastError: "boom" } as never],
      }),
      new Set(),
    );
    expect(items.map((i) => i.kind)).toEqual(["interaction", "worker-failure", "automation-failure", "worker-review"]);
    expect(items[0]).toMatchObject({ tier: 0, label: "내 세션", detail: "Deploy?", nav: { sessionId: "s1" }, dismissible: false });
  });

  it("resolved or non-live (expired) interactions are excluded", () => {
    const { items } = buildAttentionItems(
      inputs({
        logsBySession: { s1: [interaction("r1", { resolved: true }), interaction("r2")] },
        liveInteractionIds: new Set(["r1"]), // r2 not announced live (expired) — r1 resolved
      }),
      new Set(),
    );
    expect(items).toEqual([]);
  });

  it("acked failures are hidden; a NEW automation failure (new lastRunAt) re-surfaces", () => {
    const base = inputs({ automations: [{ id: "a1", name: "n", lastStatus: "error", lastRunAt: "t1" } as never] });
    expect(buildAttentionItems(base, new Set(["afail:a1:t1"])).items).toEqual([]);
    const rerun = inputs({ automations: [{ id: "a1", name: "n", lastStatus: "error", lastRunAt: "t2" } as never] });
    expect(buildAttentionItems(rerun, new Set(["afail:a1:t1"])).items).toHaveLength(1);
  });

  it("a failed worker suppresses its own review entry (lower tier wins)", () => {
    const { items } = buildAttentionItems(
      inputs({ fleet: { w1: worker("w1", "error") }, attention: { w1: true } }),
      new Set(),
    );
    expect(items.map((i) => i.kind)).toEqual(["worker-failure"]);
  });

  it("items for the currently-viewed target are excluded (mirrors the dots' semantics)", () => {
    const { items } = buildAttentionItems(
      inputs({
        logsBySession: { s1: [interaction("r1")] },
        liveInteractionIds: new Set(["r1"]),
        fleet: { w1: worker("w1", "failed") },
        sessionAttention: { s1: true },
        active: { sessionId: "s1", workerId: null, overlay: null },
      }),
      new Set(),
    );
    // the s1 interaction + s1 review are both excluded (viewing s1); the worker failure remains
    expect(items.map((i) => i.kind)).toEqual(["worker-failure"]);
  });

  it("candidateKeys carries only persisted-ack (failure) keys — feeds pruning", () => {
    const { candidateKeys } = buildAttentionItems(
      inputs({
        logsBySession: { s1: [interaction("r1")] },
        liveInteractionIds: new Set(["r1"]),
        fleet: { w1: worker("w1", "failed") },
        attention: { w9: true }, // w9 not in fleet → no item, no key
        automations: [{ id: "a1", name: "n", lastStatus: "error", lastRunAt: "t1" } as never],
      }),
      new Set(),
    );
    expect([...candidateKeys].sort()).toEqual(["afail:a1:t1", "wfail:w1:failed"]);
  });

  it("excludes orphaned workers even when a stale review flag remains", () => {
    const { items, candidateKeys } = buildAttentionItems(
      inputs({ fleet: { w1: worker("w1", "orphaned") }, attention: { w1: true } }),
      new Set(),
    );
    expect(items).toEqual([]);
    expect(candidateKeys).toEqual(new Set());
  });

  it("worker rows carry the status as a translatable label key, not the raw union token", () => {
    // detailKey routes through the same status.* catalog as StatusBadge (audit #50) so the bell never leaks a raw
    // English status word (e.g. "error"/"stopped") into the Korean-default UI. Free-text details stay on `detail`.
    const { items } = buildAttentionItems(
      inputs({ fleet: { w1: worker("w1", "error"), w2: worker("w2", "stopped") }, attention: { w2: true } }),
      new Set(),
    );
    const fail = items.find((i) => i.kind === "worker-failure")!;
    const review = items.find((i) => i.kind === "worker-review")!;
    expect(fail.detailKey).toBe("status.error");
    expect(fail.detail).toBeUndefined(); // no raw token
    expect(review.detailKey).toBe("status.stopped");
    expect(review.detail).toBeUndefined();
  });

  it("archived failed workers are excluded", () => {
    const { items } = buildAttentionItems(inputs({ fleet: { w1: worker("w1", "error", { archived: true }) } }), new Set());
    expect(items).toEqual([]);
  });
});
