import { describe, it, expect, afterEach } from "vitest";
import { render, screen, act, cleanup, fireEvent } from "@testing-library/react";
import { useCloseTabShortcut } from "../src/renderer/lib/useCloseTabShortcut.js";
import { useWsStore } from "../src/renderer/store/workspace.js";

// audit #82: Cmd/Ctrl+W closes the active editor tab (main forwards it as onCloseTab).
let fire: () => void = () => {};
(window as unknown as { rookery: unknown }).rookery = { win: { onCloseTab: (cb: () => void) => { fire = cb; return () => { fire = () => {}; }; } } };

function Host({ pageKey }: { pageKey: string }): JSX.Element {
  return <>{useCloseTabShortcut(pageKey)}</>;
}
const tabs = (dirty: boolean, active: string) => ({
  byPage: { p1: { tabs: [{ id: "agent", kind: "agent" }, { id: "file:/x.ts", kind: "file", path: "/x.ts", title: "x.ts", dirty }], activeTabId: active } },
} as never);
afterEach(() => { cleanup(); });

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
