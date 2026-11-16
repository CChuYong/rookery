import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { FileTree } from "../src/renderer/components/FileTree.js";
import { useWsStore } from "../src/renderer/store/workspace.js";
import { useToastStore } from "../src/renderer/store/toasts.js";

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
  useToastStore.setState({ toasts: [] });
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

  // audit #133 (intentional change): this one-line prompt now closes on Escape — there is no draft worth keeping, and
  // the shared draft-form convention (Escape ignored) was the reason it could not be cancelled from the keyboard.
  it("closes the name prompt on Escape and from Cancel", async () => {
    render(<FileTree root="/r" pageKey="p1" version={0} activeTabPath={null} />);
    fireEvent.contextMenu(await screen.findByText("a.ts"));
    fireEvent.click(await screen.findByText("이름 변경"));
    await screen.findByRole("dialog");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    fireEvent.contextMenu(screen.getByText("a.ts"));
    fireEvent.click(await screen.findByText("이름 변경"));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "취소" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  // audit #114: the finder says "searching…" until the walk returns, offers a retry when it fails, and flags truncation.
  it("filter: searching while the walk runs, retry on failure, truncation note", async () => {
    let finish!: (r: { paths: string[]; truncated: boolean }) => void;
    const walk = vi.fn()
      .mockReturnValueOnce(new Promise((res) => { finish = res; }))
      .mockRejectedValueOnce(new Error("EACCES"))
      .mockResolvedValue({ paths: ["a.ts"], truncated: true });
    mockWs({ walk });
    render(<FileTree root="/r" pageKey="p1" version={0} activeTabPath={null} />);
    await screen.findByText("src");
    fireEvent.change(screen.getByPlaceholderText("파일 검색"), { target: { value: "zz" } });
    expect(screen.getByText("검색하는 중…")).toBeInTheDocument();
    expect(screen.queryByText("일치하는 파일이 없어요.")).toBeNull();
    finish({ paths: ["a.ts"], truncated: false });
    expect(await screen.findByText("일치하는 파일이 없어요.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "새로고침" })); // reload → the walk fails this time
    expect(await screen.findByText("파일 목록을 불러오지 못했어요")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    fireEvent.change(screen.getByPlaceholderText("파일 검색"), { target: { value: "a" } });
    expect(await screen.findByText(/결과가 잘렸어요/)).toBeInTheDocument();
  });

  it("filter input shows fuzzy walk results and opens on click", async () => {
    render(<FileTree root="/r" pageKey="p1" version={0} activeTabPath={null} />);
    await screen.findByText("src");
    fireEvent.change(screen.getByPlaceholderText("파일 검색"), { target: { value: "bts" } });
    const hit = await screen.findByText("src/b.ts");
    fireEvent.click(hit);
    await waitFor(() => expect(useWsStore.getState().byPage.p1?.activeTabId).toBe("file:/r/src/b.ts"));
  });

  describe("root loading/error/empty states (#13)", () => {
    it("shows a loading skeleton — not the empty-folder copy — while the root listing is in flight", async () => {
      let resolveList: ((v: Array<{ name: string; isDir: boolean }>) => void) | null = null;
      mockWs({ list: vi.fn(() => new Promise((res) => { resolveList = res; })) });
      const { container } = render(<FileTree root="/r" pageKey="p1" version={0} activeTabPath={null} />);
      expect(screen.queryByText("빈 폴더예요.")).toBeNull();
      expect(container.querySelector(".sheen")).not.toBeNull();
      resolveList!([]);
      await waitFor(() => expect(screen.getByText("빈 폴더예요.")).toBeInTheDocument());
    });

    it("shows loadFailed (not emptyFolder) when the root listing rejects, and retry re-fetches", async () => {
      const list = vi.fn().mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce([{ name: "a.ts", isDir: false }]);
      mockWs({ list });
      render(<FileTree root="/r" pageKey="p1" version={0} activeTabPath={null} />);
      expect(await screen.findByText("목록을 불러오지 못했어요 — 다시 시도")).toBeInTheDocument();
      expect(screen.queryByText("빈 폴더예요.")).toBeNull();
      fireEvent.click(screen.getByText("목록을 불러오지 못했어요 — 다시 시도"));
      expect(await screen.findByText("a.ts")).toBeInTheDocument();
      expect(list).toHaveBeenCalledTimes(2);
    });

    it("shows the emptyFolder copy only after a successful empty listing", async () => {
      mockWs({ list: vi.fn(async () => []) });
      render(<FileTree root="/r" pageKey="p1" version={0} activeTabPath={null} />);
      expect(await screen.findByText("빈 폴더예요.")).toBeInTheDocument();
    });

    it("does not re-flash the skeleton on a background refetch after a successful initial load (task 10 review)", async () => {
      let resolveRefetch: ((v: Array<{ name: string; isDir: boolean }>) => void) | null = null;
      let calls = 0;
      const list = vi.fn(() => {
        calls += 1;
        if (calls === 1) return Promise.resolve([{ name: "src", isDir: true }, { name: "a.ts", isDir: false }]);
        return new Promise<Array<{ name: string; isDir: boolean }>>((res) => { resolveRefetch = res; });
      });
      mockWs({ list });
      const { rerender, container } = render(<FileTree root="/r" pageKey="p1" version={0} activeTabPath={null} />);
      expect(await screen.findByText("a.ts")).toBeInTheDocument();

      // Bump version (simulates a live fs:tree event) — the refetch is held open via the pending promise.
      rerender(<FileTree root="/r" pageKey="p1" version={1} activeTabPath={null} />);
      await waitFor(() => expect(list).toHaveBeenCalledTimes(2));

      // The already-rendered rows must stay put — no skeleton flash while the refetch is in flight.
      expect(screen.getByText("a.ts")).toBeInTheDocument();
      expect(screen.getByText("src")).toBeInTheDocument();
      expect(container.querySelector(".sheen")).toBeNull();

      resolveRefetch!([{ name: "src", isDir: true }, { name: "a.ts", isDir: false }]);
      await waitFor(() => expect(screen.getByText("a.ts")).toBeInTheDocument());
    });
  });

  describe("fs-op failure feedback (#11)", () => {
    // audit #133 (intentional change): the prompt stays open while the rename runs and shows the failure inline,
    // keeping the typed name — it used to close first, so a failure left only a toast and the name was gone.
    it("keeps the name prompt open with an inline error when a rename rejects", async () => {
      mockWs({ rename: vi.fn(async () => { throw new Error("boom"); }) });
      render(<FileTree root="/r" pageKey="p1" version={0} activeTabPath={null} />);
      fireEvent.contextMenu(await screen.findByText("a.ts"));
      fireEvent.click(await screen.findByText("이름 변경"));
      const dialog = await screen.findByRole("dialog");
      const input = within(dialog).getByRole("textbox");
      fireEvent.change(input, { target: { value: "renamed.ts" } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(await within(dialog).findByText(/파일 작업에 실패했어요/)).toBeInTheDocument();
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(input).toHaveValue("renamed.ts");
      expect(input).toHaveAttribute("aria-invalid", "true");
    });

    it("toasts opFailed when a trash rejects", async () => {
      mockWs({ trash: vi.fn(async () => { throw new Error("boom"); }) });
      render(<FileTree root="/r" pageKey="p1" version={0} activeTabPath={null} />);
      fireEvent.contextMenu(await screen.findByText("a.ts"));
      fireEvent.click(await screen.findByText("삭제"));
      const dialog = await screen.findByRole("dialog");
      fireEvent.click(within(dialog).getByRole("button", { name: "삭제" }));
      await waitFor(() => expect(useToastStore.getState().toasts.some((x) => x.text === "파일 작업에 실패했어요")).toBe(true));
    });
  });

  // audit #68: rename/delete/menu from the keyboard, not only by right-click.
  describe("keyboard row actions (audit #68)", () => {
    it("F2 renames the selected row (basename preselected), Delete asks to trash, Shift+F10 opens its menu", async () => {
      render(<FileTree root="/r" pageKey="p1" version={0} activeTabPath={null} />);
      await screen.findByText("a.ts");
      const body = screen.getByTestId("filetree-body");
      fireEvent.keyDown(body, { key: "End" }); // select a.ts
      fireEvent.keyDown(body, { key: "F2" });
      const input = within(await screen.findByRole("dialog")).getByRole("textbox") as HTMLInputElement;
      expect(input.value).toBe("a.ts");
      expect([input.selectionStart, input.selectionEnd]).toEqual([0, 1]); // "a" — the extension is left out
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "취소" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      fireEvent.keyDown(body, { key: "Delete" });
      expect(await screen.findByText(/휴지통/)).toBeInTheDocument();
      fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "취소" }));
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      fireEvent.keyDown(body, { key: "F10", shiftKey: true });
      expect(screen.getByRole("menu")).toBeInTheDocument();
    });

    it("rows are not their own tab stops; the tree points at the selection with aria-activedescendant", async () => {
      render(<FileTree root="/r" pageKey="p1" version={0} activeTabPath={null} />);
      const row = (await screen.findByText("a.ts")).closest("[data-path]") as HTMLElement;
      expect(row).toHaveAttribute("tabindex", "-1");
      const body = screen.getByTestId("filetree-body");
      fireEvent.keyDown(body, { key: "End" });
      expect(body.getAttribute("aria-activedescendant")).toBe(row.id);
    });
  });

  // audit #69: the finder results were mouse-only.
  describe("filter keyboard (audit #69)", () => {
    it("Enter in the search box opens the top match; ArrowDown moves into the results, Arrow/Enter there", async () => {
      render(<FileTree root="/r" pageKey="p1" version={0} activeTabPath={null} />);
      await screen.findByText("src");
      const search = screen.getByRole("textbox", { name: "파일 검색" });
      fireEvent.change(search, { target: { value: "ts" } });
      await screen.findByText("src/b.ts");
      fireEvent.keyDown(search, { key: "Enter", keyCode: 229 }); // IME commit — ignored
      expect(useWsStore.getState().byPage.p1?.activeTabId).toBeUndefined();
      fireEvent.keyDown(search, { key: "Enter" });
      await waitFor(() => expect(useWsStore.getState().byPage.p1?.activeTabId).toBe("file:/r/a.ts"));

      fireEvent.keyDown(search, { key: "ArrowDown" });
      const body = screen.getByTestId("filetree-body");
      expect(document.activeElement).toBe(body);
      fireEvent.keyDown(body, { key: "ArrowDown" });
      fireEvent.keyDown(body, { key: "Enter" });
      await waitFor(() => expect(useWsStore.getState().byPage.p1?.activeTabId).toBe("file:/r/src/b.ts"));
    });
  });
});
