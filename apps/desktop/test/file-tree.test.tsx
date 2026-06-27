import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { FileTree } from "../src/renderer/components/FileTree.js";
import { useWsStore } from "../src/renderer/store/workspace.js";

function mockWs(over: Record<string, unknown> = {}) {
  (globalThis as any).window = (globalThis as any).window ?? {};
  (window as any).rookery = { ws: {
    list: vi.fn(async (dir: string) => {
      if (dir === "/r") return [{ name: "src", isDir: true }, { name: "a.ts", isDir: false }];
      if (dir === "/r/src") return [{ name: "b.ts", isDir: false }];
      return [];
    }),
    gitStatus: vi.fn(async () => [{ path: "a.ts", status: "M" }]),
    walk: vi.fn(async () => ({ paths: ["a.ts", "src/b.ts"], truncated: false })),
    createFile: vi.fn(async () => ({ ok: true })),
    mkdir: vi.fn(async () => ({ ok: true })),
    rename: vi.fn(async () => ({ ok: true })),
    trash: vi.fn(async () => ({ ok: true })),
    ...over,
  } };
}

beforeEach(() => {
  mockWs();
  useWsStore.setState({ byPage: {}, expandedByPage: {}, right: { open: true, width: 300, segment: "files" } });
});

describe("FileTree", () => {
  it("lists root entries", async () => {
    render(<FileTree root="/r" pageKey="p1" version={0} activeTabPath={null} />);
    expect(await screen.findByText("src")).toBeInTheDocument();
    expect(screen.getByText("a.ts")).toBeInTheDocument();
  });

  it("expands a folder on click and persists to the store", async () => {
    render(<FileTree root="/r" pageKey="p1" version={0} activeTabPath={null} />);
    fireEvent.click(await screen.findByText("src"));
    expect(await screen.findByText("b.ts")).toBeInTheDocument();
    expect(useWsStore.getState().expandedByPage.p1).toContain("/r/src");
  });

  it("opens a file on click", async () => {
    render(<FileTree root="/r" pageKey="p1" version={0} activeTabPath={null} />);
    fireEvent.click(await screen.findByText("a.ts"));
    await waitFor(() => expect(useWsStore.getState().byPage.p1?.activeTabId).toBe("file:/r/a.ts"));
  });

  it("marks the active file row", async () => {
    render(<FileTree root="/r" pageKey="p1" version={0} activeTabPath="/r/a.ts" />);
    const row = (await screen.findByText("a.ts")).closest("[data-path]") as HTMLElement;
    expect(row.getAttribute("data-active")).toBe("true");
  });

  it("shows a git status marker for changed files", async () => {
    render(<FileTree root="/r" pageKey="p1" version={0} activeTabPath={null} />);
    await screen.findByText("a.ts");
    await waitFor(() => expect(screen.getByTestId("git-/r/a.ts").textContent).toBe("M"));
  });

  it("collapse-all button clears expansion", async () => {
    useWsStore.setState({ expandedByPage: { p1: ["/r/src"] } });
    render(<FileTree root="/r" pageKey="p1" version={0} activeTabPath={null} />);
    await screen.findByText("b.ts"); // src is expanded
    fireEvent.click(screen.getByLabelText("전체 접기"));
    await waitFor(() => expect(screen.queryByText("b.ts")).not.toBeInTheDocument());
  });

  it("arrow keys move selection and Enter opens a file", async () => {
    render(<FileTree root="/r" pageKey="p1" version={0} activeTabPath={null} />);
    await screen.findByText("src");
    const body = screen.getByTestId("filetree-body");
    fireEvent.keyDown(body, { key: "ArrowDown" }); // select src
    fireEvent.keyDown(body, { key: "ArrowDown" }); // select a.ts
    fireEvent.keyDown(body, { key: "Enter" });
    await waitFor(() => expect(useWsStore.getState().byPage.p1?.activeTabId).toBe("file:/r/a.ts"));
  });

  it("ArrowRight expands the selected directory", async () => {
    render(<FileTree root="/r" pageKey="p1" version={0} activeTabPath={null} />);
    await screen.findByText("src");
    const body = screen.getByTestId("filetree-body");
    fireEvent.keyDown(body, { key: "ArrowDown" }); // select src
    fireEvent.keyDown(body, { key: "ArrowRight" });
    expect(await screen.findByText("b.ts")).toBeInTheDocument();
    expect(useWsStore.getState().expandedByPage.p1).toContain("/r/src");
  });

  it("right-click a file shows a context menu; Delete opens the in-app confirm and trashes", async () => {
    render(<FileTree root="/r" pageKey="p1" version={0} activeTabPath={null} />);
    fireEvent.contextMenu(await screen.findByText("a.ts"));
    fireEvent.click(await screen.findByText("삭제")); // menu item
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "삭제" })); // confirm button
    await waitFor(() => expect((window as any).rookery.ws.trash).toHaveBeenCalledWith("/r/a.ts"));
  });

  it("Rename opens the in-app name dialog and calls ws.rename with the new path", async () => {
    render(<FileTree root="/r" pageKey="p1" version={0} activeTabPath={null} />);
    fireEvent.contextMenu(await screen.findByText("a.ts"));
    fireEvent.click(await screen.findByText("이름 변경")); // menu item
    const dialog = await screen.findByRole("dialog");
    const input = within(dialog).getByRole("textbox");
    fireEvent.change(input, { target: { value: "renamed.ts" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect((window as any).rookery.ws.rename).toHaveBeenCalledWith("/r/a.ts", "/r/renamed.ts"));
  });

  it("filter input shows fuzzy walk results and opens on click", async () => {
    render(<FileTree root="/r" pageKey="p1" version={0} activeTabPath={null} />);
    await screen.findByText("src");
    fireEvent.change(screen.getByPlaceholderText("파일 검색"), { target: { value: "bts" } });
    const hit = await screen.findByText("src/b.ts");
    fireEvent.click(hit);
    await waitFor(() => expect(useWsStore.getState().byPage.p1?.activeTabId).toBe("file:/r/src/b.ts"));
  });
});
