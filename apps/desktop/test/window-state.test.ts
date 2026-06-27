import { describe, it, expect } from "vitest";
import { loadWindowState, serializeWindowState } from "../src/main/window-state.js";

const display = { x: 0, y: 0, width: 1920, height: 1080 };

describe("window-state", () => {
  it("defaults when no file", () => {
    expect(loadWindowState({ read: () => null, displays: [display] })).toEqual({ width: 1280, height: 860 });
  });
  it("defaults on malformed json", () => {
    expect(loadWindowState({ read: () => "{bad", displays: [display] })).toEqual({ width: 1280, height: 860 });
  });
  it("restores on-screen bounds", () => {
    const json = serializeWindowState({ x: 100, y: 80, width: 1000, height: 700 }, false);
    expect(loadWindowState({ read: () => json, displays: [display] })).toEqual({ width: 1000, height: 700, x: 100, y: 80, maximized: false });
  });
  it("drops x/y when off all displays (monitor removed)", () => {
    const json = serializeWindowState({ x: 5000, y: 5000, width: 1000, height: 700 }, false);
    const st = loadWindowState({ read: () => json, displays: [display] });
    expect(st).toEqual({ width: 1000, height: 700, maximized: false });
  });
  it("preserves maximized", () => {
    const json = serializeWindowState({ x: 0, y: 0, width: 1280, height: 860 }, true);
    expect(loadWindowState({ read: () => json, displays: [display] }).maximized).toBe(true);
  });
});
