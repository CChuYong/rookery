import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import { useCloseTabShortcut } from "../src/renderer/lib/useCloseTabShortcut.js";
import { useWsStore } from "../src/renderer/store/workspace.js";

// audit #82: Cmd/Ctrl+W closes the active editor tab (main forwards it as onCloseTab).
let fire: () => void = () => {};
const termWrite = vi.fn();
const setRookery = (platform: string) => {
  (window as unknown as { rookery: unknown }).rookery = { platform, term: { write: termWrite }, win: { onCloseTab: (cb: () => void) => { fire = cb; return () => { fire = () => {}; }; } } };
};
setRookery("darwin");

function Host({ pageKey }: { pageKey: string }): JSX.Element {
  return <>{useCloseTabShortcut(pageKey)}</>;
}
const tabs = (dirty: boolean, active: string) => ({
  byPage: { p1: { tabs: [{ id: "agent", kind: "agent" }, { id: "file:/x.ts", kind: "file", path: "/x.ts", title: "x.ts", dirty }], activeTabId: active } },
} as never);
afterEach(() => { cleanup(); setRookery("darwin"); termWrite.mockClear(); document.body.innerHTML = ""; });

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
