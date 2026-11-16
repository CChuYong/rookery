import { describe, it, expect, beforeEach } from "vitest";
import { readViewState, writeViewState, hasRestorableView } from "../src/renderer/lib/view-state.js";

describe("view-state", () => {
  beforeEach(() => localStorage.clear());
  it("returns null when nothing stored", () => {
    expect(readViewState()).toBeNull();
  });
  it("round-trips a view state", () => {
    writeViewState({ showRepos: true, sessionId: "s1", subId: "a1" });
    expect(readViewState()).toEqual({ showRepos: true, sessionId: "s1", subId: "a1" });
  });
  it("returns null on malformed json", () => {
    localStorage.setItem("rookery.view", "{not json");
    expect(readViewState()).toBeNull();
  });
  it("coerces missing fields to safe defaults", () => {
    localStorage.setItem("rookery.view", JSON.stringify({ showRepos: "yes" }));
    expect(readViewState()).toEqual({ showRepos: true, sessionId: null, subId: null });
  });
});

// audit #43: only a saved session/worker is worth a cold-start skeleton.
describe("hasRestorableView", () => {
  it("true for a saved session or worker, false for nothing or a bare tab choice", () => {
    expect(hasRestorableView(null)).toBe(false);
    expect(hasRestorableView({ showRepos: true, sessionId: null, subId: null })).toBe(false);
    expect(hasRestorableView({ showRepos: false, sessionId: "s1", subId: null })).toBe(true);
    expect(hasRestorableView({ showRepos: true, sessionId: null, subId: "w1" })).toBe(true);
  });
});
