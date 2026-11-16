import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import { useCloseTabShortcut } from "../src/renderer/lib/useCloseTabShortcut.js";
import { useWsStore } from "../src/renderer/store/workspace.js";
import { useCloseTabDispatch } from "../src/renderer/lib/close-tab-dispatch.js";

// audit #82: Cmd/Ctrl+W closes the active editor tab (main forwards it as onCloseTab).
let fire: () => void = () => {};
const termWrite = vi.fn();
const winClose = vi.fn();
const setReady = vi.fn();
const setRookery = (platform: string) => {
  (window as unknown as { rookery: unknown }).rookery = { platform, term: { write: termWrite }, win: { close: winClose, setCloseTabReady: setReady, onCloseTab: (cb: () => void) => { fire = cb; return () => { fire = () => {}; }; } } };
};
setRookery("darwin");

// App mounts the dispatcher once; workspace pages register their handler through the hook.
function Dispatch(): null { useCloseTabDispatch(); return null; }
function Page({ pageKey }: { pageKey: string }): JSX.Element {
  return <>{useCloseTabShortcut(pageKey)}</>;
}
function Host({ pageKey }: { pageKey: string }): JSX.Element {
  return <><Dispatch /><Page pageKey={pageKey} /></>;
}
const tabs = (dirty: boolean, active: string) => ({
  byPage: { p1: { tabs: [{ id: "agent", kind: "agent" }, { id: "file:/x.ts", kind: "file", path: "/x.ts", title: "x.ts", dirty }], activeTabId: active } },
} as never);
afterEach(() => { cleanup(); setRookery("darwin"); termWrite.mockClear(); winClose.mockClear(); setReady.mockClear(); document.body.innerHTML = ""; });

describe("useCloseTabShortcut (audit #82)", () => {
  it("closes a clean active editor tab", () => {
    useWsStore.setState(tabs(false, "file:/x.ts"));
    render(<Host pageKey="p1" />);
    act(() => fire());
    expect(useWsStore.getState().byPage.p1?.tabs.map((x) => x.id)).toEqual(["agent"]);
  });
  it("asks before closing an unsaved tab", () => {
    useWsStore.setState(tabs(true, "file:/x.ts"));
    render(<Host pageKey="p1" />);
    act(() => fire());
    expect(screen.getByText("저장 안 된 변경이 있어요")).toBeInTheDocument();
    expect(useWsStore.getState().byPage.p1?.tabs).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "저장 안 함" }));
    expect(useWsStore.getState().byPage.p1?.tabs.map((x) => x.id)).toEqual(["agent"]);
  });
  it("does nothing on the conversation tab", () => {
    useWsStore.setState(tabs(false, "agent"));
    render(<Host pageKey="p1" />);
    act(() => fire());
    expect(useWsStore.getState().byPage.p1?.tabs).toHaveLength(2);
  });
});

// Review fix 4: on Windows/Linux Ctrl+W is the shell's delete-word; with focus in a terminal it goes to the shell.
describe("useCloseTabShortcut with focus in a terminal (review fix 4)", () => {
  function focusTerminal(): void {
    const host = document.createElement("div");
    host.dataset.termId = "t1";
    const input = document.createElement("textarea");
    host.appendChild(input);
    document.body.appendChild(host);
    input.focus();
  }
  it("Windows/Linux: sends Ctrl+W (0x17) to the focused terminal instead of closing the tab", () => {
    setRookery("linux");
    useWsStore.setState(tabs(false, "file:/x.ts"));
    render(<Host pageKey="p1" />);
    focusTerminal();
    act(() => fire());
    expect(termWrite).toHaveBeenCalledWith("t1", "\x17");
    expect(useWsStore.getState().byPage.p1?.tabs).toHaveLength(2);
  });
  it("macOS: Cmd+W still closes the tab (the shell's delete-word is Ctrl+W there, not intercepted)", () => {
    setRookery("darwin");
    useWsStore.setState(tabs(false, "file:/x.ts"));
    render(<Host pageKey="p1" />);
    focusTerminal();
    act(() => fire());
    expect(termWrite).not.toHaveBeenCalled();
    expect(useWsStore.getState().byPage.p1?.tabs.map((x) => x.id)).toEqual(["agent"]);
  });
});

// Final review #2: main always intercepts the key, so the renderer must close the window itself when no page takes
// it, and must never act behind a modal layer.
describe("Cmd/Ctrl+W routing (final review #2)", () => {
  it("closes the window when no workspace page handles the key (Settings, Automation, New session, spawn page)", () => {
    render(<Dispatch />);
    act(() => fire());
    expect(winClose).toHaveBeenCalledTimes(1);
  });
  it("keeps the window on the pinned conversation tab of a workspace page", () => {
    useWsStore.setState(tabs(false, "agent"));
    render(<Host pageKey="p1" />);
    act(() => fire());
    expect(winClose).not.toHaveBeenCalled();
  });
  it("does nothing behind an open modal layer: no tab close, no window close", () => {
    useWsStore.setState(tabs(false, "file:/x.ts"));
    render(<Host pageKey="p1" />);
    const modal = document.createElement("div");
    modal.setAttribute("aria-modal", "true");
    document.body.appendChild(modal);
    act(() => fire());
    expect(useWsStore.getState().byPage.p1?.tabs).toHaveLength(2);
    expect(winClose).not.toHaveBeenCalled();
  });
  it("does not stack a second confirm while the unsaved-tab confirm is open", () => {
    useWsStore.setState(tabs(true, "file:/x.ts"));
    render(<Host pageKey="p1" />);
    act(() => fire());
    act(() => fire());
    expect(screen.getAllByText("저장 안 된 변경이 있어요")).toHaveLength(1);
    expect(winClose).not.toHaveBeenCalled();
  });
  it("Windows/Linux: a focused terminal gets delete-word even on a page without editor tabs", () => {
    setRookery("linux");
    render(<Dispatch />);
    const host = document.createElement("div");
    host.dataset.termId = "t9";
    const input = document.createElement("textarea");
    host.appendChild(input);
    document.body.appendChild(host);
    input.focus();
    act(() => fire());
    expect(termWrite).toHaveBeenCalledWith("t9", "\x17");
    expect(winClose).not.toHaveBeenCalled();
  });
});

// Round 2 (re-review C): main forwards Cmd+W only while the dispatcher is mounted. Before it mounts, or after the
// tree is gone (a render crash unmounts it), main closes the window itself, so the key is never dead.
describe("Cmd/Ctrl+W readiness signal (round 2)", () => {
  it("reports ready on mount and gone on unmount", () => {
    const { unmount } = render(<Dispatch />);
    expect(setReady).toHaveBeenLastCalledWith(true);
    unmount();
    expect(setReady).toHaveBeenLastCalledWith(false);
  });
});
