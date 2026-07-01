import { describe, it, expect, beforeEach } from "vitest";
import { isDockableEnabled } from "../../src/renderer/lib/flags.js";

describe("isDockableEnabled", () => {
  beforeEach(() => localStorage.clear());
  it("defaults to false", () => {
    expect(isDockableEnabled()).toBe(false);
  });
  it("is true when the flag is exactly '1'", () => {
    localStorage.setItem("rookery.dockable", "1");
    expect(isDockableEnabled()).toBe(true);
  });
  it("is false for any other value", () => {
    localStorage.setItem("rookery.dockable", "yes");
    expect(isDockableEnabled()).toBe(false);
  });
});
