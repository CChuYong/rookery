import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TabBar } from "../src/renderer/components/TabBar.js";
import { useWsStore, emptyWsState, openFile, setDirty } from "../src/renderer/store/workspace.js";

describe("TabBar close button keyboard focus reveal (audit #24)", () => {
  it("the close-X button reveals on focus-within/focus-visible, not just hover", () => {
    useWsStore.setState({
      byPage: { p1: { tabs: [{ id: "f1", kind: "file", path: "/x.ts", title: "x.ts", dirty: false }], activeTabId: "f1" } },
    });
    render(<TabBar pageKey="p1" agentLabel="Master" />);
    const closeBtn = screen.getByRole("button", { name: "탭 닫기" });
    // opacity-0 + group-hover:opacity-100 alone would stay invisible to a keyboard-only user — the
    // focus-within/focus-visible reveal (matching Sessions.tsx's row actions) must also be present.
    expect(closeBtn.className).toMatch(/\bopacity-0\b/);
    expect(closeBtn.className).toMatch(/\bgroup-focus-within:opacity-100\b/);
    expect(closeBtn.className).toMatch(/\bfocus-visible:opacity-100\b/);
  });
});

describe("TabBar dirty-tab close confirm (audit #44)", () => {
  const FILE_ID = "file:/x.ts";
  // Built via the store's own pure helpers (rather than a hand-rolled byPage literal) so the
  // fixture matches real state exactly: the pinned "agent" tab is always present alongside
  // file tabs (it's never closable), and openFile/setDirty produce the real Tab shapes.
  const withFileTab = (dirty: boolean) => setDirty(openFile(emptyWsState(), "p1", "/x.ts"), "p1", FILE_ID, dirty);

  it("closing a clean tab closes immediately with no dialog", () => {
    useWsStore.setState(withFileTab(false));
    render(<TabBar pageKey="p1" agentLabel="Master" />);
    fireEvent.click(screen.getByRole("button", { name: "탭 닫기" }));
    expect(screen.queryByText("저장 안 된 변경이 있어요")).toBeNull();
    expect(useWsStore.getState().byPage.p1?.tabs.some((tb) => tb.id === FILE_ID)).toBe(false);
  });

  it("closing a dirty tab opens the confirm and does NOT close the tab", () => {
    useWsStore.setState(withFileTab(true));
    render(<TabBar pageKey="p1" agentLabel="Master" />);
    fireEvent.click(screen.getByRole("button", { name: "탭 닫기" }));
    expect(screen.getByText("저장 안 된 변경이 있어요")).toBeInTheDocument();
    expect(screen.getByText("'x.ts' 탭을 닫으면 편집 내용이 사라져요.")).toBeInTheDocument();
    expect(useWsStore.getState().byPage.p1?.tabs.some((tb) => tb.id === FILE_ID)).toBe(true);
  });

  it("Discard in the confirm dialog closes the tab", () => {
    useWsStore.setState(withFileTab(true));
    render(<TabBar pageKey="p1" agentLabel="Master" />);
    fireEvent.click(screen.getByRole("button", { name: "탭 닫기" }));
    fireEvent.click(screen.getByText("저장 안 함"));
    expect(useWsStore.getState().byPage.p1?.tabs.some((tb) => tb.id === FILE_ID)).toBe(false);
  });

  it("Cancel in the confirm dialog keeps the tab open", () => {
    useWsStore.setState(withFileTab(true));
    render(<TabBar pageKey="p1" agentLabel="Master" />);
    fireEvent.click(screen.getByRole("button", { name: "탭 닫기" }));
    fireEvent.click(screen.getByText("취소"));
    expect(useWsStore.getState().byPage.p1?.tabs.some((tb) => tb.id === FILE_ID)).toBe(true);
  });
});
