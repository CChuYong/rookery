import { describe, it, expect } from "vitest";
import { windowShortcut } from "../../src/main/window-shortcuts.js";

const key = (over: Partial<Parameters<typeof windowShortcut>[0]> = {}) => ({ type: "keyDown", key: "w", meta: false, control: false, shift: false, alt: false, ...over });

describe("windowShortcut (audit #82)", () => {
  it("Cmd+W on macOS closes the editor tab, Shift+Cmd+W the window", () => {
    expect(windowShortcut(key({ meta: true }), "darwin")).toBe("closeTab");
    expect(windowShortcut(key({ meta: true, shift: true, key: "W" }), "darwin")).toBe("closeWindow");
  });
  it("Ctrl+W on Windows/Linux closes the editor tab, Ctrl+Shift+W the window", () => {
    expect(windowShortcut(key({ control: true }), "win32")).toBe("closeTab");
    expect(windowShortcut(key({ control: true, shift: true }), "linux")).toBe("closeWindow");
  });
  it("ignores other keys, key-up, Alt, and the wrong modifier for the platform", () => {
    expect(windowShortcut(key({ meta: true, key: "q" }), "darwin")).toBeNull();
    expect(windowShortcut(key({ meta: true, type: "keyUp" }), "darwin")).toBeNull();
    expect(windowShortcut(key({ meta: true, alt: true }), "darwin")).toBeNull();
    expect(windowShortcut(key({ control: true }), "darwin")).toBeNull();
    expect(windowShortcut(key({ meta: true }), "linux")).toBeNull();
  });
});
