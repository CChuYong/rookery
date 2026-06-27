import { describe, it, expect, beforeEach } from "vitest";
import { readViewState, writeViewState } from "../src/renderer/lib/view-state.js";

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
