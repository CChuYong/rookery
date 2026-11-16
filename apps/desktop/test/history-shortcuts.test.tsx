import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useHistoryShortcuts, historyShortcutFor } from "../src/renderer/lib/useHistoryShortcuts.js";

// audit #10: back/forward had no keyboard or mouse alternative (and the buttons vanished in a narrow sidebar).
describe("historyShortcutFor", () => {
  const key = (k: Partial<KeyboardEvent>) => ({ key: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...k });
  it("maps Cmd+[ / Cmd+] on macOS", () => {
    expect(historyShortcutFor(key({ key: "[", metaKey: true }), "darwin")).toBe("back");
    expect(historyShortcutFor(key({ key: "]", metaKey: true }), "darwin")).toBe("forward");
    expect(historyShortcutFor(key({ key: "[" }), "darwin")).toBeNull();
    expect(historyShortcutFor(key({ key: "ArrowLeft", altKey: true }), "darwin")).toBeNull(); // word-jump on macOS
  });
  it("maps Alt+Left / Alt+Right elsewhere", () => {
    expect(historyShortcutFor(key({ key: "ArrowLeft", altKey: true }), "win32")).toBe("back");
    expect(historyShortcutFor(key({ key: "ArrowRight", altKey: true }), "linux")).toBe("forward");
    expect(historyShortcutFor(key({ key: "ArrowLeft", altKey: true, shiftKey: true }), "linux")).toBeNull();
  });
});

function Harness({ back, fwd }: { back: () => void; fwd: () => void }): JSX.Element {
  useHistoryShortcuts(back, fwd);
  return <div><input aria-label="field" /><button>btn</button></div>;
}

describe("useHistoryShortcuts", () => {
  afterEach(() => { delete (window as unknown as { rookery?: unknown }).rookery; });

  it("goes back/forward on the shortcut, but not while typing in a field", () => {
    (window as unknown as { rookery: unknown }).rookery = { platform: "darwin" };
    const back = vi.fn(); const fwd = vi.fn();
    const { getByLabelText, getByText } = render(<Harness back={back} fwd={fwd} />);
    fireEvent.keyDown(getByText("btn"), { key: "[", metaKey: true });
    expect(back).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(getByText("btn"), { key: "]", metaKey: true });
    expect(fwd).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(getByLabelText("field"), { key: "[", metaKey: true }); // editor outdent etc. keep the key
    expect(back).toHaveBeenCalledTimes(1);
  });

  it("maps the mouse back/forward buttons", () => {
    (window as unknown as { rookery: unknown }).rookery = { platform: "win32" };
    const back = vi.fn(); const fwd = vi.fn();
    const { getByText } = render(<Harness back={back} fwd={fwd} />);
    fireEvent.mouseUp(getByText("btn"), { button: 3 });
    fireEvent.mouseUp(getByText("btn"), { button: 4 });
    fireEvent.mouseUp(getByText("btn"), { button: 0 });
    expect(back).toHaveBeenCalledTimes(1);
    expect(fwd).toHaveBeenCalledTimes(1);
  });
});

// audit #140: the IDE shortcut set beyond Ctrl+` — sidebar, new session, settings.
describe("appShortcutFor (audit #140)", () => {
  it("maps Cmd+B/N/, on macOS and Ctrl elsewhere; ignores Shift/Alt and the other modifier", async () => {
    const { appShortcutFor } = await import("../src/renderer/lib/shortcuts.js");
    const key = (k: Partial<KeyboardEvent>) => ({ key: "", metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...k });
    expect(appShortcutFor(key({ key: "b", metaKey: true }), "darwin")).toBe("toggleSidebar");
    expect(appShortcutFor(key({ key: "n", metaKey: true }), "darwin")).toBe("newSession");
    expect(appShortcutFor(key({ key: ",", metaKey: true }), "darwin")).toBe("settings");
    expect(appShortcutFor(key({ key: "b", ctrlKey: true }), "darwin")).toBeNull();
    expect(appShortcutFor(key({ key: "b", ctrlKey: true }), "linux")).toBe("toggleSidebar");
    expect(appShortcutFor(key({ key: "B", ctrlKey: true, shiftKey: true }), "win32")).toBeNull();
  });

  it("useAppShortcuts fires outside text fields only", async () => {
    const { useAppShortcuts } = await import("../src/renderer/lib/shortcuts.js");
    (window as unknown as { rookery: unknown }).rookery = { platform: "darwin" };
    const toggleSidebar = vi.fn();
    function H(): JSX.Element {
      useAppShortcuts({ toggleSidebar, newSession: () => {}, settings: () => {} });
      return <div><input aria-label="field" /><button>btn</button></div>;
    }
    const { getByLabelText, getByText } = render(<H />);
    fireEvent.keyDown(getByLabelText("field"), { key: "b", metaKey: true });
    expect(toggleSidebar).not.toHaveBeenCalled();
    fireEvent.keyDown(getByText("btn"), { key: "b", metaKey: true });
    expect(toggleSidebar).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(getByText("btn"), { key: "b", metaKey: true, repeat: true }); // fix round 1: auto-repeat ignored
    expect(toggleSidebar).toHaveBeenCalledTimes(1);
    delete (window as unknown as { rookery?: unknown }).rookery;
  });
});
