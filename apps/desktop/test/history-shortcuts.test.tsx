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
  return (
    <div>
      <input aria-label="field" />
      <div contentEditable="true" suppressContentEditableWarning aria-label="composer" />
      <div className="monaco-editor"><textarea aria-label="monaco" /></div>
      <div className="xterm"><textarea aria-label="xterm" /></div>
      <button>btn</button>
    </div>
  );
}

describe("useHistoryShortcuts", () => {
  afterEach(() => { delete (window as unknown as { rookery?: unknown }).rookery; });

  it("goes back/forward on the shortcut; Monaco and xterm keep the key", () => {
    (window as unknown as { rookery: unknown }).rookery = { platform: "darwin" };
    const back = vi.fn(); const fwd = vi.fn();
    const { getByLabelText, getByText } = render(<Harness back={back} fwd={fwd} />);
    fireEvent.keyDown(getByText("btn"), { key: "[", metaKey: true });
    expect(back).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(getByText("btn"), { key: "]", metaKey: true });
    expect(fwd).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(getByLabelText("monaco"), { key: "[", metaKey: true }); // Monaco outdent keeps the key
    fireEvent.keyDown(getByLabelText("xterm"), { key: "[", metaKey: true });
    expect(back).toHaveBeenCalledTimes(1);
  });

  // Final review #3: Cmd+[ / Cmd+] from the composer or a plain field (the normal focus state) navigates on macOS.
  it("macOS: Cmd+[ / Cmd+] work from a text field and the composer", () => {
    (window as unknown as { rookery: unknown }).rookery = { platform: "darwin" };
    const back = vi.fn(); const fwd = vi.fn();
    const { getByLabelText } = render(<Harness back={back} fwd={fwd} />);
    fireEvent.keyDown(getByLabelText("field"), { key: "[", metaKey: true });
    fireEvent.keyDown(getByLabelText("composer"), { key: "]", metaKey: true });
    expect(back).toHaveBeenCalledTimes(1);
    expect(fwd).toHaveBeenCalledTimes(1);
  });

  it("Windows/Linux: Alt+Arrow never navigates from a text field (word navigation)", () => {
    (window as unknown as { rookery: unknown }).rookery = { platform: "win32" };
    const back = vi.fn(); const fwd = vi.fn();
    const { getByLabelText, getByText } = render(<Harness back={back} fwd={fwd} />);
    fireEvent.keyDown(getByLabelText("field"), { key: "ArrowLeft", altKey: true });
    fireEvent.keyDown(getByLabelText("composer"), { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(getByLabelText("monaco"), { key: "ArrowLeft", altKey: true });
    expect(back).not.toHaveBeenCalled();
    expect(fwd).not.toHaveBeenCalled();
    fireEvent.keyDown(getByText("btn"), { key: "ArrowLeft", altKey: true });
    expect(back).toHaveBeenCalledTimes(1);
  });

  // Final review #4: an open modal owns the keyboard and the mouse; history must not navigate underneath it.
  it("ignores the keys and the mouse buttons while a modal layer is open", () => {
    (window as unknown as { rookery: unknown }).rookery = { platform: "darwin" };
    const back = vi.fn(); const fwd = vi.fn();
    const { getByText } = render(<Harness back={back} fwd={fwd} />);
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    try {
      fireEvent.keyDown(getByText("btn"), { key: "[", metaKey: true });
      fireEvent.mouseUp(getByText("btn"), { button: 3 });
      fireEvent.mouseUp(getByText("btn"), { button: 4 });
      expect(back).not.toHaveBeenCalled();
      expect(fwd).not.toHaveBeenCalled();
    } finally {
      modal.remove();
    }
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

  it("useAppShortcuts fires outside Monaco and xterm", async () => {
    const { useAppShortcuts } = await import("../src/renderer/lib/shortcuts.js");
    (window as unknown as { rookery: unknown }).rookery = { platform: "darwin" };
    const toggleSidebar = vi.fn();
    function H(): JSX.Element {
      useAppShortcuts({ toggleSidebar, newSession: () => {}, settings: () => {} });
      return <div><div className="monaco-editor"><textarea aria-label="monaco" /></div><div className="xterm"><textarea aria-label="xterm" /></div><button>btn</button></div>;
    }
    const { getByLabelText, getByText } = render(<H />);
    fireEvent.keyDown(getByLabelText("monaco"), { key: "b", metaKey: true });
    fireEvent.keyDown(getByLabelText("xterm"), { key: "b", metaKey: true });
    expect(toggleSidebar).not.toHaveBeenCalled();
    fireEvent.keyDown(getByText("btn"), { key: "b", metaKey: true });
    expect(toggleSidebar).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(getByText("btn"), { key: "b", metaKey: true, repeat: true }); // fix round 1: auto-repeat ignored
    expect(toggleSidebar).toHaveBeenCalledTimes(1);
    delete (window as unknown as { rookery?: unknown }).rookery;
  });
});

// Final review #3: the app shortcuts are advertised in tooltips, so they must work from the composer (the normal
// focus state). Per key: macOS Cmd combos pass through text fields; on Windows/Linux Ctrl+B / Ctrl+N stay editing
// keys in text fields (Ctrl+, has no editing meaning and passes).
describe("useAppShortcuts from text fields (final review #3)", () => {
  afterEach(() => { delete (window as unknown as { rookery?: unknown }).rookery; });
  async function mount(platform: string) {
    const { useAppShortcuts } = await import("../src/renderer/lib/shortcuts.js");
    (window as unknown as { rookery: unknown }).rookery = { platform };
    const calls = { toggleSidebar: vi.fn(), newSession: vi.fn(), settings: vi.fn() };
    function H(): JSX.Element {
      useAppShortcuts(calls);
      return <div><input aria-label="field" /><div contentEditable="true" suppressContentEditableWarning aria-label="composer" /></div>;
    }
    const r = render(<H />);
    return { ...r, calls };
  }
  it("macOS: Cmd+N, Cmd+, and Cmd+B fire from a field and the composer", async () => {
    const { getByLabelText, calls } = await mount("darwin");
    fireEvent.keyDown(getByLabelText("composer"), { key: "n", metaKey: true });
    fireEvent.keyDown(getByLabelText("field"), { key: ",", metaKey: true });
    fireEvent.keyDown(getByLabelText("composer"), { key: "b", metaKey: true });
    expect(calls.newSession).toHaveBeenCalledTimes(1);
    expect(calls.settings).toHaveBeenCalledTimes(1);
    expect(calls.toggleSidebar).toHaveBeenCalledTimes(1);
  });
  it("Windows/Linux: Ctrl+B / Ctrl+N stay with the text field; Ctrl+, opens settings", async () => {
    const { getByLabelText, calls } = await mount("linux");
    fireEvent.keyDown(getByLabelText("field"), { key: "b", ctrlKey: true });
    fireEvent.keyDown(getByLabelText("composer"), { key: "n", ctrlKey: true });
    expect(calls.toggleSidebar).not.toHaveBeenCalled();
    expect(calls.newSession).not.toHaveBeenCalled();
    fireEvent.keyDown(getByLabelText("field"), { key: ",", ctrlKey: true });
    expect(calls.settings).toHaveBeenCalledTimes(1);
  });
  it("a field that handled the key itself (defaultPrevented) keeps it", async () => {
    const { getByLabelText, calls } = await mount("darwin");
    const field = getByLabelText("field");
    field.addEventListener("keydown", (e) => e.preventDefault());
    fireEvent.keyDown(field, { key: "b", metaKey: true });
    expect(calls.toggleSidebar).not.toHaveBeenCalled();
  });
});
