import { describe, it, expect, beforeEach } from "vitest";
import { usePrefsStore } from "../../src/renderer/store/prefs.js";

describe("prefs store", () => {
  beforeEach(() => { localStorage.clear(); usePrefsStore.setState({ localePref: "system" }); });
  it("defaults to system", () => {
    expect(usePrefsStore.getState().localePref).toBe("system");
  });
  it("setLocalePref updates and persists to rookery.prefs", () => {
    usePrefsStore.getState().setLocalePref("en");
    expect(usePrefsStore.getState().localePref).toBe("en");
    expect(localStorage.getItem("rookery.prefs")).toContain("\"localePref\":\"en\"");
  });
});
