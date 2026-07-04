import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import type { IDockviewPanelHeaderProps } from "dockview";
import { RookeryTab } from "../src/renderer/workspace/RookeryTab.js";
import { useWsStore } from "../src/renderer/store/workspace.js";

// Minimal fake of the dockview panel-header props RookeryTab actually reads
// (api.title / api.onDidTitleChange / api.close + params) — the rest of the
// real DockviewPanelApi surface is irrelevant to this component.
function renderTab(tabId: string, title: string): { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  const api = { title, onDidTitleChange: () => ({ dispose: () => {} }), close };
  const props = { api, containerApi: {}, tabLocation: "header", params: { pageKey: "p1", kind: "editor", tabId } };
  render(<RookeryTab {...(props as unknown as IDockviewPanelHeaderProps)} />);
  return { close };
}

// Renders a fixed (non-editor) panel tab — params carry no tabId/dirty concept.
function renderFixedTab(kind: "conversation" | "files" | "git" | "terminal" | "nested"): { close: ReturnType<typeof vi.fn> } {
  const close = vi.fn();
  const api = { title: kind, onDidTitleChange: () => ({ dispose: () => {} }), close };
  const params = kind === "conversation" ? { pageKey: "p1", kind, agentKind: "master" as const } : { pageKey: "p1", kind };
  const props = { api, containerApi: {}, tabLocation: "header", params };
  render(<RookeryTab {...(props as unknown as IDockviewPanelHeaderProps)} />);
  return { close };
}

// audit #48: fixed panels (Files/Git/Terminal/Nested) must be closable — closing
// HIDES the dock panel (WorkspaceDock mirrors it into dockPanelsStore and offers
// a way back via the header toggles) — but the pinned conversation must stay
// non-closable (WorkspaceDock's own re-add guard is the OTHER half of that
// invariant; this only pins what RookeryTab renders).
describe("RookeryTab close affordance per panel kind (audit #48)", () => {
  it("shows a close button for fixed non-conversation panels and closing calls api.close() with no confirm", () => {
    for (const kind of ["files", "git", "terminal", "nested"] as const) {
      const { close } = renderFixedTab(kind);
      fireEvent.click(screen.getByRole("button", { name: "탭 닫기" }));
      expect(close).toHaveBeenCalledTimes(1);
      expect(screen.queryByText("저장 안 된 변경이 있어요")).toBeNull();
      cleanup(); // each iteration renders a fresh tab — without this, later getByRole calls see stale ones too
    }
  });

  it("renders no close button for the pinned conversation panel", () => {
    renderFixedTab("conversation");
    expect(screen.queryByRole("button", { name: "탭 닫기" })).toBeNull();
  });
});

// Proves the dockview close path is gated by the SAME TabCloseConfirm as the legacy
// TabBar's X (audit #44) — not a second, duplicated dialog.
describe("RookeryTab dirty-tab close confirm (audit #44)", () => {
  it("closing a clean editor tab calls api.close() immediately with no dialog", () => {
    useWsStore.setState({
      byPage: { p1: { tabs: [{ id: "file:/x.ts", kind: "file", path: "/x.ts", title: "x.ts", dirty: false }], activeTabId: "file:/x.ts" } },
    });
    const { close } = renderTab("file:/x.ts", "x.ts");
    fireEvent.click(screen.getByRole("button", { name: "탭 닫기" }));
    expect(close).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("저장 안 된 변경이 있어요")).toBeNull();
  });

  it("closing a dirty editor tab opens the shared confirm and does NOT call api.close()", () => {
    useWsStore.setState({
      byPage: { p1: { tabs: [{ id: "file:/x.ts", kind: "file", path: "/x.ts", title: "x.ts", dirty: true }], activeTabId: "file:/x.ts" } },
    });
    const { close } = renderTab("file:/x.ts", "x.ts");
    fireEvent.click(screen.getByRole("button", { name: "탭 닫기" }));
    expect(close).not.toHaveBeenCalled();
    expect(screen.getByText("저장 안 된 변경이 있어요")).toBeInTheDocument();
    expect(screen.getByText("'x.ts' 탭을 닫으면 편집 내용이 사라져요.")).toBeInTheDocument();
  });

  it("Discard in the confirm dialog calls api.close()", () => {
    useWsStore.setState({
      byPage: { p1: { tabs: [{ id: "file:/x.ts", kind: "file", path: "/x.ts", title: "x.ts", dirty: true }], activeTabId: "file:/x.ts" } },
    });
    const { close } = renderTab("file:/x.ts", "x.ts");
    fireEvent.click(screen.getByRole("button", { name: "탭 닫기" }));
    fireEvent.click(screen.getByText("저장 안 함"));
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("Cancel in the confirm dialog leaves api.close() uncalled", () => {
    useWsStore.setState({
      byPage: { p1: { tabs: [{ id: "file:/x.ts", kind: "file", path: "/x.ts", title: "x.ts", dirty: true }], activeTabId: "file:/x.ts" } },
    });
    const { close } = renderTab("file:/x.ts", "x.ts");
    fireEvent.click(screen.getByRole("button", { name: "탭 닫기" }));
    fireEvent.click(screen.getByText("취소"));
    expect(close).not.toHaveBeenCalled();
  });
});
