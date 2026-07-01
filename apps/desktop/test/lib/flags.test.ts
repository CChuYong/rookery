import { describe, it, expect, beforeEach } from "vitest";
import { isDockableEnabled } from "../../src/renderer/lib/flags.js";

describe("isDockableEnabled", () => {
  beforeEach(() => localStorage.clear());
  it("defaults to true (dockable is the default layout)", () => {
    expect(isDockableEnabled()).toBe(true);
  });
  it("is false only when explicitly opted out with '0'", () => {
    localStorage.setItem("rookery.dockable", "0");
    expect(isDockableEnabled()).toBe(false);
  });
  it("stays true for '1' or any other value", () => {
    localStorage.setItem("rookery.dockable", "1");
    expect(isDockableEnabled()).toBe(true);
    localStorage.setItem("rookery.dockable", "yes");
    expect(isDockableEnabled()).toBe(true);
  });
});
