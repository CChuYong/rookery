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
    expect(s.byPage["session-1"]).toEqual({text:"hello world",images:[]});
  });

  it("setDraft keeps drafts isolated per page key", () => {
    let s = emptyDraftState();
    s = setDraft(s, "a", "draft A");
    s = setDraft(s, "b", "draft B");
    expect(s.byPage).toEqual({ a: {text:"draft A",images:[]}, b: {text:"draft B",images:[]} });
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
    expect(pruned.byPage).toEqual({ alive: {text:"keep me",images:[]} });
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
    expect(pruned.byPage).toEqual({ [NEW_SESSION_DRAFT_KEY]: {text:"unsent new-session prompt",images:[]} });
  });
});

it("migrates legacy drafts and persists only image references", async () => {
  const { migrateDrafts, setDraft } = await import("../src/renderer/store/drafts.js");
  const s = migrateDrafts({ byPage: { old: "hello" } });
  expect(s.byPage.old).toEqual({ text: "hello", images: [] });
  const image = { id: "550e8400-e29b-41d4-a716-446655440000", name: "a.png", mediaType: "image/png" as const, byteLength: 1, width: 1, height: 1, base64: "never-store-me" };
  const next = setDraft(s, "image", "", [image]);
  expect(next.byPage.image.images).toHaveLength(1);
  expect(JSON.stringify(next)).not.toContain("never-store-me");
});
it('does not clear a newer identical draft after an old acceptance finishes across navigation',async()=>{
 const {useDraftStore,clearAcceptedDraft}=await import('../src/renderer/store/drafts.js');
 useDraftStore.getState().setDraft_('s','repeat');const accepted=useDraftStore.getState().byPage.s;
 useDraftStore.getState().setDraft_('s','repeat');
 clearAcceptedDraft('s','repeat',[],accepted);
 expect(useDraftStore.getState().byPage.s.text).toBe('repeat');
});
it('keeps stable Side drafts only while their source target exists',async()=>{
 const {sideDraftKey}=await import('../src/renderer/store/drafts.js');
 let state=emptyDraftState();
 state=setDraft(state,sideDraftKey('master','alive'),'master follow-up');
 state=setDraft(state,sideDraftKey('worker','alive'),'worker follow-up');
 state=setDraft(state,sideDraftKey('master','dead'),'remove');
 state=setDraft(state,'side:legacy-ephemeral','unreachable legacy');
 const pruned=pruneDrafts(state,new Set(['alive']));
 expect(Object.keys(pruned.byPage)).toEqual(['side:master:alive','side:worker:alive']);
 expect(pruned.byPage[sideDraftKey('master','alive')].text).toBe('master follow-up');
});

describe("spawn page drafts (spawnWorker:<repo>)", () => {
  it("setSpawnDraft stores task + label under the per-repo key and removes the entry when both are empty", async () => {
    const { setSpawnDraft, spawnDraftKey } = await import("../src/renderer/store/drafts.js");
    let s = setSpawnDraft(emptyDraftState(), "app", "fix the flaky test", "flaky");
    expect(spawnDraftKey("app")).toBe("spawnWorker:app");
    expect(s.byPage["spawnWorker:app"]).toEqual({ text: "fix the flaky test", images: [], label: "flaky" });
    s = setSpawnDraft(s, "app", "", "only a label");
    expect(s.byPage["spawnWorker:app"]).toEqual({ text: "", images: [], label: "only a label" });
    s = setSpawnDraft(s, "app", "", "");
    expect("spawnWorker:app" in s.byPage).toBe(false);
  });

  it("migrateDrafts keeps a spawn draft's label across reloads", async () => {
    const { migrateDrafts } = await import("../src/renderer/store/drafts.js");
    const s = migrateDrafts({ byPage: { "spawnWorker:app": { text: "t", images: [], label: "l" }, x: { text: "y", images: [], label: 3 } } });
    expect(s.byPage["spawnWorker:app"]).toEqual({ text: "t", images: [], label: "l" });
    expect(s.byPage.x).toEqual({ text: "y", images: [] });
  });

  it("pruneDrafts always keeps spawn drafts (the repo list may not have loaded at prune time)", async () => {
    const { setSpawnDraft } = await import("../src/renderer/store/drafts.js");
    let s = setSpawnDraft(emptyDraftState(), "app", "unsent spawn task", "");
    s = setDraft(s, "dead-worker", "drop me");
    const pruned = pruneDrafts(s, new Set<string>());
    expect(Object.keys(pruned.byPage)).toEqual(["spawnWorker:app"]);
  });
});
