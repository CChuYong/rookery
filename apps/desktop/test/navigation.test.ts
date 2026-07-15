import { describe, it, expect } from "vitest";
import { initialNav, navigate, back, forward, reset, sameLoc, type Location } from "../src/renderer/store/navigation.js";

const L = (p: Partial<Location> = {}): Location => ({ overlay: null, showRepos: false, sessionId: null, subId: null, ...p });

describe("navigation model", () => {
  it("navigate pushes current to back, clears forward, sets next", () => {
    let st = initialNav;
    st = navigate(st, { sessionId: "s1" });
    expect(st.loc).toEqual(L({ sessionId: "s1" }));
    expect(st.back).toEqual([L()]); // previous (empty location)
    expect(st.forward).toEqual([]);
  });

  it("navigate to same location is a no-op (no history pollution)", () => {
    let st = navigate(initialNav, { sessionId: "s1" });
    const before = st;
    st = navigate(st, { sessionId: "s1" }); // same
    expect(st).toBe(before); // reference unchanged
  });

  it("back/forward round-trip restores locations", () => {
    let st = initialNav;
    st = navigate(st, { sessionId: "s1" });
    st = navigate(st, { showRepos: true, subId: "a1" });
    expect(st.loc).toEqual(L({ sessionId: "s1", showRepos: true, subId: "a1" }));
    st = back(st);
    expect(st.loc).toEqual(L({ sessionId: "s1" })); // previous
    expect(st.forward.length).toBe(1);
    st = forward(st);
    expect(st.loc).toEqual(L({ sessionId: "s1", showRepos: true, subId: "a1" })); // forward again
    expect(st.forward).toEqual([]);
  });

  it("navigate after back discards the forward branch (browser semantics)", () => {
    let st = navigate(initialNav, { sessionId: "s1" });
    st = navigate(st, { overlay: "settings" });
    st = back(st); // → s1
    expect(st.forward.length).toBe(1);
    st = navigate(st, { overlay: "automation" }); // new branch → discard forward
    expect(st.forward).toEqual([]);
    expect(forward(st)).toBe(st); // nowhere to go forward → no-op
  });

  it("back/forward on empty stacks are no-ops", () => {
    expect(back(initialNav)).toBe(initialNav);
    expect(forward(initialNav)).toBe(initialNav);
  });

  it("reset sets location with empty history (entry on restore)", () => {
    let st = navigate(initialNav, { sessionId: "s1" });
    st = reset(L({ showRepos: true, subId: "a9" }));
    expect(st).toEqual({ loc: L({ showRepos: true, subId: "a9" }), back: [], forward: [] });
    expect(back(st)).toBe(st); // nothing to go back to
  });

  it("sameLoc compares all 4 axes", () => {
    expect(sameLoc(L({ sessionId: "s1" }), L({ sessionId: "s1" }))).toBe(true);
    expect(sameLoc(L({ sessionId: "s1" }), L({ sessionId: "s2" }))).toBe(false);
    expect(sameLoc(L({ overlay: "settings" }), L())).toBe(false);
  });

  it("Capability Center preserves its selected session or worker through back/forward", () => {
    let st = navigate(initialNav, { showRepos: true, subId: "w1" });
    st = navigate(st, { overlay: "capabilities" });
    expect(st.loc).toEqual(L({ overlay: "capabilities", showRepos: true, subId: "w1" }));
    st = back(st);
    expect(st.loc).toEqual(L({ showRepos: true, subId: "w1" }));
    st = forward(st);
    expect(st.loc).toEqual(L({ overlay: "capabilities", showRepos: true, subId: "w1" }));
  });
});
