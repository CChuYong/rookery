import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, act, cleanup } from "@testing-library/react";
import { WorkspaceDock } from "../../src/renderer/workspace/WorkspaceDock.js";
import { WorkspaceRenderProvider, type WorkspaceRender } from "../../src/renderer/workspace/WorkspaceRender.js";
import { useDockPanelsStore } from "../../src/renderer/store/dock-panels.js";
import { useLayoutStore, emptyLayoutState } from "../../src/renderer/store/layout.js";
import { useTermStore } from "../../src/renderer/store/terminals.js";
import { useToastStore } from "../../src/renderer/store/toasts.js";
import { useWsStore, emptyWsState } from "../../src/renderer/store/workspace.js";
import { savedSideColumnWidth, sideColumnWidth, type SerializedGrid, type GridNode } from "../../src/renderer/workspace/dock-layout.js";
import type { DockviewApi } from "dockview";

// The mounted dock against a real dockview: jsdom has no layout, so these pin the visibility state machine (what is
// hidden by whom, what the toggles read, what gets saved), not pixel sizes — those live in dock-layout.test.ts.
const stub: WorkspaceRender = { conversation: () => null, editor: () => null, terminal: () => null, files: () => null, git: () => null, nested: () => null };

// Capture the dock's ResizeObserver so a test can "resize" the dock.
let resize: (width: number) => void = () => {};
class FakeResizeObserver {
  constructor(private cb: ResizeObserverCallback) {}
  observe(): void { resize = (width) => this.cb([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
  unobserve(): void {}
  disconnect(): void {}
}

const hidden = () => useDockPanelsStore.getState().hiddenByPage.p ?? [];
const auto = () => useDockPanelsStore.getState().autoHiddenByPage.p ?? [];
const savedGrid = () => (useLayoutStore.getState().byPage.p as { grid: SerializedGrid } | undefined)?.grid;
const leaves = (node: GridNode): GridNode[] => (node.type === "leaf" ? [node] : node.data.flatMap(leaves));

function mount(): void {
  render(<WorkspaceRenderProvider value={stub}><WorkspaceDock pageKey="p" agentKind="master" /></WorkspaceRenderProvider>);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0));
  useDockPanelsStore.setState({ hiddenByPage: {}, autoHiddenByPage: {} });
  useLayoutStore.setState({ ...emptyLayoutState(), resetSeq: {} });
  useTermStore.setState({ byPage: {}, layout: {}, shellRequests: {} });
  useToastStore.setState({ toasts: [] });
  useWsStore.setState(emptyWsState());
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("WorkspaceDock visibility (audit #4 #7 #80 #81)", () => {
  it("a fresh page seeds files+git and leaves the terminal closed", () => {
    mount();
    expect(hidden()).toEqual(["terminal"]);
    expect(auto()).toEqual([]);
  });

  it("a narrow dock hides the side panel as auto-hidden (not as the user's choice) and growing back shows it", () => {
    mount();
    act(() => resize(600));
    expect(auto().sort()).toEqual(["files", "git"]);
    expect(hidden()).toEqual(["terminal"]); // the user's own set is untouched
    act(() => resize(1400));
    expect(auto()).toEqual([]);
    expect(hidden()).toEqual(["terminal"]);
  });

  it("a panel the user hides while narrow stays hidden when the window grows (audit #7)", () => {
    mount();
    act(() => resize(600));
    act(() => useDockPanelsStore.getState().toggleGroup_("p", ["files", "git"])); // auto → open
    expect(auto()).toEqual([]);
    act(() => useDockPanelsStore.getState().toggleGroup_("p", ["files", "git"])); // open → closed by the user
    act(() => resize(1400));
    expect(hidden().sort()).toEqual(["files", "git", "terminal"]);
  });

  it("saves layout changes made while narrow, with the side panel saved visible (audit #81)", async () => {
    mount();
    // dockview batches its layout-change event on a microtask, so let it run before advancing the save debounce.
    await act(async () => { resize(600); await Promise.resolve(); });
    act(() => { vi.advanceTimersByTime(500); });
    const grid = savedGrid();
    expect(grid).toBeDefined();
    const sideLeaf = leaves(grid!.root).find((l) => l.type === "leaf" && l.data.views?.includes("panel:files"));
    expect(sideLeaf?.visible).not.toBe(false);
  });

  it("showing the terminal on a page with no shell asks for one (audit #80)", () => {
    mount();
    act(() => useDockPanelsStore.getState().toggle_("p", "terminal"));
    expect(hidden()).toEqual([]);
    expect(useTermStore.getState().shellRequests.p).toBe(1);
  });

  it("Reset keeps a showing terminal and offers Undo, even with nothing saved (audit #79 #81)", () => {
    mount();
    act(() => useDockPanelsStore.getState().toggle_("p", "terminal"));
    act(() => useDockPanelsStore.getState().toggleGroup_("p", ["files", "git"])); // hide the side panel
    act(() => useLayoutStore.getState().reset_("p"));
    expect(hidden()).toEqual([]); // side panel back, terminal kept
    const t = useToastStore.getState().toasts.at(-1);
    expect(t?.action).toBeDefined();
    act(() => t!.action!.onClick());
    expect(hidden().sort()).toEqual(["files", "git"]); // undo restores the pre-reset layout
  });
});

describe("WorkspaceDock worker seed (audit #13)", () => {
  it("opens the side column on Git, not on the usually empty Activity tab", () => {
    const { container } = render(<WorkspaceRenderProvider value={stub}><WorkspaceDock pageKey="w" agentKind="worker" /></WorkspaceRenderProvider>);
    const activeKinds = Array.from(container.querySelectorAll(".dv-tab.dv-active-tab .rk-tab")).map((el) => el.getAttribute("data-kind"));
    expect(activeKinds).toContain("git");
    expect(activeKinds).not.toContain("nested");
  });
});

// Review fix 1: shrinking squeezes the side column to its minimum before the narrow rule hides it; the dock must
// remember the width the user chose and bring that back (and save it), not the squeezed one.
describe("WorkspaceDock side column width through a narrow window (review fix 1)", () => {
  async function flush(): Promise<void> {
    await act(async () => { await Promise.resolve(); vi.advanceTimersByTime(500); await Promise.resolve(); });
  }
  function mountWithApi(): DockviewApi {
    let api!: DockviewApi;
    render(<WorkspaceRenderProvider value={stub}><WorkspaceDock pageKey="p" agentKind="master" onApi={(a) => { api = a; }} /></WorkspaceRenderProvider>);
    return api;
  }

  it("returns at 320 after 1440 → 662 → 1188, and saves 320 while narrow", async () => {
    const api = mountWithApi();
    act(() => { api.layout(1400, 900); resize(1400); });
    await flush();
    expect(sideColumnWidth(api)).toBe(320);
    act(() => { api.layout(662, 900); resize(662); }); // dockview squeezes first, then the narrow rule hides it
    await flush();
    expect(auto().sort()).toEqual(["files", "git"]);
    expect(savedSideColumnWidth(savedGrid()!)).toBe(320);
    act(() => { api.layout(1188, 900); resize(1188); });
    await flush();
    expect(auto()).toEqual([]);
    expect(sideColumnWidth(api)).toBe(320);
  });

  it("remembers a width the user dragged to", async () => {
    const api = mountWithApi();
    act(() => { api.layout(1400, 900); resize(1400); });
    await flush();
    const sash = document.querySelector(".dv-sash")!;
    act(() => {
      sash.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      api.getPanel("panel:files")!.group.api.setSize({ width: 400 });
      window.dispatchEvent(new MouseEvent("pointerup", { bubbles: true }));
    });
    act(() => { api.layout(662, 900); resize(662); });
    await flush();
    act(() => { api.layout(1400, 900); resize(1400); });
    await flush();
    expect(sideColumnWidth(api)).toBe(400);
  });
});

// Review fix 3: a page opened in a narrow window hides the side column once — no hide → show → hide flash.
describe("WorkspaceDock narrow start (review fix 3)", () => {
  it("never shows the side column again after the first auto-hide", () => {
    const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "clientWidth");
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get() { return (this as HTMLElement).classList.contains("dockview-theme-rookery") ? 600 : 0; } });
    const history: string[][] = [];
    const unsub = useDockPanelsStore.subscribe((st) => { history.push([...(st.autoHiddenByPage.p ?? [])]); });
    try {
      mount();
      const firstHide = history.findIndex((h) => h.length > 0);
      expect(firstHide).toBeGreaterThanOrEqual(0);
      expect(history.slice(firstHide).every((h) => h.length > 0)).toBe(true);
      expect(auto().sort()).toEqual(["files", "git"]);
    } finally {
      unsub();
      if (original) Object.defineProperty(HTMLElement.prototype, "clientWidth", original);
    }
  });
});
