import { describe, it, expect } from "vitest";
import { emptyDraftState, setDraft, pruneDrafts } from "../src/renderer/store/drafts.js";
import { NEW_SESSION_DRAFT_KEY } from "../src/renderer/components/NewSessionPage.js";

describe("drafts reducer", () => {
  it("a fresh state has no drafts", () => {
    expect(emptyDraftState()).toEqual({ byPage: {} });
  });

  it("setDraft stores text per page key", () => {
    let s = emptyDraftState();
    s = setDraft(s, "session-1", "hello world");
    expect(s.byPage["session-1"]).toBe("hello world");
  });

  it("setDraft keeps drafts isolated per page key", () => {
    let s = emptyDraftState();
    s = setDraft(s, "a", "draft A");
    s = setDraft(s, "b", "draft B");
    expect(s.byPage).toEqual({ a: "draft A", b: "draft B" });
  });

  it("setDraft with empty text removes the draft (no empty entries persisted)", () => {
    let s = emptyDraftState();
    s = setDraft(s, "a", "typing…");
    s = setDraft(s, "a", "");
    expect(s.byPage).toEqual({});
    expect("a" in s.byPage).toBe(false);
  });

  it("setDraft returns a new state object (immutability)", () => {
    const s = emptyDraftState();
    const s2 = setDraft(s, "a", "x");
    expect(s2).not.toBe(s);
    expect(s.byPage).toEqual({});
  });

  it("pruneDrafts drops keys not in the known set (dead-page cleanup)", () => {
    let s = emptyDraftState();
    s = setDraft(s, "alive", "keep me");
    s = setDraft(s, "dead", "drop me");
    const pruned = pruneDrafts(s, new Set(["alive"]));
    expect(pruned.byPage).toEqual({ alive: "keep me" });
  });

  // Audit #5 review: NEW_SESSION_DRAFT_KEY is a fixed page key, not a session/worker id, so a "known" set built only
  // from session ids ∪ fleet worker ids (App.tsx's boot-time prune) must still special-case it in — otherwise the
  // New Session draft is wiped on every app restart, contradicting the "survive reloads" purpose above.
  it("pruneDrafts keeps the newSession draft when the known set includes NEW_SESSION_DRAFT_KEY (survives boot pruning with no live sessions/workers)", () => {
    let s = emptyDraftState();
    s = setDraft(s, NEW_SESSION_DRAFT_KEY, "unsent new-session prompt");
    s = setDraft(s, "dead-worker", "drop me");
    // Simulates App.tsx's known set on a fresh boot with zero sessions/workers, but with the fixed key added in.
    const known = new Set<string>([NEW_SESSION_DRAFT_KEY]);
    const pruned = pruneDrafts(s, known);
    expect(pruned.byPage).toEqual({ [NEW_SESSION_DRAFT_KEY]: "unsent new-session prompt" });
  });
});
