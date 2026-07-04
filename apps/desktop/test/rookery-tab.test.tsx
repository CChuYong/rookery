import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
