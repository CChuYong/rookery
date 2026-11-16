import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkerHeader, SessionHeader } from "../src/renderer/components/WorkspaceHeaders.js";
import { I18nProvider } from "../src/renderer/i18n/provider.js";
import { usePrefsStore } from "../src/renderer/store/prefs.js";
import { useDockPanelsStore } from "../src/renderer/store/dock-panels.js";
import { useLayoutStore, emptyLayoutState } from "../src/renderer/store/layout.js";
import { useStore } from "../src/renderer/store/store.js";

const baseProps = {
  termPageKey: null, termPageOpen: false, rightOpen: false,
  onToggleTerm: () => {}, onToggleRight: () => {},
  onFetchCheckpoints: async () => [], onRestore: async () => {},
};

const openExternal = vi.fn();
beforeEach(() => {
  // OpenInAppMenu (header right side) reads window.rookery.apps.list, so mock it too.
  (window as unknown as { rookery: unknown }).rookery = { openExternal, apps: { list: async () => [] } };
  useStore.setState({ workflows: {} });
});

describe("WorkerHeader background reason", () => {
  it("shows active workflow count without replacing the worker status", () => {
    useStore.setState({ workflows: { w1: { task: { taskId: "task", workflowName: "audit", summary: "", status: "running", visibility: "live", startedAt: 1, lastActivityAt: 2, counts: { started: 1, active: 1, completed: 0, stopped: 0 }, agents: [] } } } } as never);
    render(<WorkerHeader {...baseProps} worker={{ id: "w1", label: "t", repoPath: "/r", status: "background", branch: null, model: null, bg: { count: 1, types: ["local_workflow"] } } as never} />);
    expect(screen.getByText("워크플로 · 1")).toBeInTheDocument();
    expect(screen.getByText("백그라운드 작업 중")).toBeInTheDocument();
    expect(screen.queryByText("백그라운드 · 1")).toBeNull();
  });

  it("shows only the status badge (no activity text) for a background worker with bg but no listed tasks, and hides reasons once idle", () => {
    const { rerender } = render(<WorkerHeader {...baseProps} worker={{ id: "w2", label: "t", repoPath: "/r", status: "background", branch: null, model: null, bg: { count: 2, types: ["local_bash"] } } as never} />);
    expect(screen.getByText("백그라운드 작업 중")).toBeInTheDocument();
    expect(screen.queryByText(/백그라운드 ·/)).toBeNull();
    expect(screen.queryByRole("button", { name: "백그라운드 작업" })).toBeNull();
    rerender(<WorkerHeader {...baseProps} worker={{ id: "w2", label: "t", repoPath: "/r", status: "idle", branch: null, model: null } as never} />);
    expect(screen.queryByText(/백그라운드 ·/)).toBeNull();
    expect(screen.queryByText(/워크플로 ·/)).toBeNull();
  });
});
describe("WorkerHeader background task list", () => {
  const tasks = [{ id: "b1", type: "local_bash", description: "npm test --watch" }, { id: "b2", type: "local_bash", description: "vite dev" }];

  it("shows \"2 bg\" while running when two tasks are listed", () => {
    render(<WorkerHeader {...baseProps} worker={{ id: "wt1", label: "t", repoPath: "/r", status: "running", branch: null, model: null, tasks } as never} />);
    expect(screen.getByRole("button", { name: "백그라운드 작업" })).toHaveTextContent("백그라운드 · 2");
  });

  it("clicking opens a menu with one \"Stop: <description>\" item per task, and choosing one calls onStopTask(\"b1\")", () => {
    const onStopTask = vi.fn();
    render(<WorkerHeader {...baseProps} onStopTask={onStopTask} worker={{ id: "wt2", label: "t", repoPath: "/r", status: "background", branch: null, model: null, bg: { count: 2, types: ["local_bash"] }, tasks } as never} />);
    fireEvent.click(screen.getByRole("button", { name: "백그라운드 작업" }));
    const items = screen.getAllByRole("menuitem");
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent("중지: npm test --watch");
    expect(items[1]).toHaveTextContent("중지: vite dev");
    fireEvent.click(items[0]!);
    expect(onStopTask).toHaveBeenCalledTimes(1);
    expect(onStopTask).toHaveBeenCalledWith("b1");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("truncates a long description to 80 characters with an ellipsis and falls back to the task type when it is empty", () => {
    const long = "x".repeat(79) + "😀" + "tail that must not show";
    const odd = [{ id: "b1", type: "local_bash", description: long }, { id: "b2", type: "monitor", description: "" }];
    render(<WorkerHeader {...baseProps} worker={{ id: "wt6", label: "t", repoPath: "/r", status: "running", branch: null, model: null, tasks: odd } as never} />);
    fireEvent.click(screen.getByRole("button", { name: "백그라운드 작업" }));
    const items = screen.getAllByRole("menuitem");
    expect(items[0]).toHaveTextContent(`중지: ${"x".repeat(79)}😀…`); // the 80th character is a whole emoji, never half a surrogate pair
    expect(items[0]).not.toHaveTextContent("tail");
    expect(items[1]).toHaveTextContent("중지: monitor");
  });

  it("does not reopen a stale menu when the tasks drop to empty and later reappear", () => {
    const w = { id: "wt5", label: "t", repoPath: "/r", status: "running", branch: null, model: null };
    const { rerender } = render(<WorkerHeader {...baseProps} worker={{ ...w, tasks } as never} />);
    fireEvent.click(screen.getByRole("button", { name: "백그라운드 작업" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    rerender(<WorkerHeader {...baseProps} worker={{ ...w, tasks: [] } as never} />);
    expect(screen.queryByRole("menu")).toBeNull();
    rerender(<WorkerHeader {...baseProps} worker={{ ...w, tasks } as never} />);
    expect(screen.getByRole("button", { name: "백그라운드 작업" })).toBeInTheDocument();
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("no task button when tasks are empty or absent (codex worker)", () => {
    const { rerender } = render(<WorkerHeader {...baseProps} worker={{ id: "wt3", label: "t", repoPath: "/r", status: "running", branch: null, model: null, tasks: [] } as never} />);
    expect(screen.queryByRole("button", { name: "백그라운드 작업" })).toBeNull();
    rerender(<WorkerHeader {...baseProps} worker={{ id: "wt3", label: "t", repoPath: "/r", status: "running", branch: null, model: null, provider: "codex" } as never} />);
    expect(screen.queryByRole("button", { name: "백그라운드 작업" })).toBeNull();
    expect(screen.queryByText(/백그라운드 ·/)).toBeNull();
  });

  it("workflow label still wins when a workflow is running", () => {
    useStore.setState({ workflows: { wt4: { task: { taskId: "task", workflowName: "audit", summary: "", status: "running", visibility: "live", startedAt: 1, lastActivityAt: 2, counts: { started: 1, active: 1, completed: 0, stopped: 0 }, agents: [] } } } } as never);
    render(<WorkerHeader {...baseProps} worker={{ id: "wt4", label: "t", repoPath: "/r", status: "background", branch: null, model: null, bg: { count: 1, types: ["local_workflow"] }, tasks } as never} />);
    expect(screen.getByText("워크플로 · 1")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "백그라운드 작업" })).toBeNull();
  });
});
afterEach(() => { openExternal.mockReset(); delete (window as unknown as { rookery?: unknown }).rookery; });

describe("WorkerHeader ticket link", () => {
  it("renders a ticket button that opens the ticket url externally", () => {
    render(<WorkerHeader {...baseProps} worker={{ id: "w1", label: "t", repoPath: "/r", status: "running", branch: "rookery/eng-1", model: null, ticketKey: "ENG-1", ticketUrl: "https://l/ENG-1" } as never} />);
    fireEvent.click(screen.getByText("ENG-1"));
    expect(openExternal).toHaveBeenCalledWith("https://l/ENG-1");
  });

  it("shows no ticket button when the worker has no ticket", () => {
    render(<WorkerHeader {...baseProps} worker={{ id: "w2", label: "t", repoPath: "/r", status: "running", branch: "rookery/a0", model: null } as never} />);
    expect(screen.queryByText("ENG-1")).toBeNull();
  });
});

describe("WorkerHeader provider badge (Codex)", () => {
  it("renders a 'Codex' badge when the worker's provider is codex", () => {
    render(<WorkerHeader {...baseProps} worker={{ id: "w4", label: "t", repoPath: "/r", status: "running", branch: "rookery/a0", model: null, provider: "codex" } as never} />);
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });

  it("renders no badge when the worker's provider is absent (claude default)", () => {
    render(<WorkerHeader {...baseProps} worker={{ id: "w5", label: "t", repoPath: "/r", status: "running", branch: "rookery/a0", model: null } as never} />);
    expect(screen.queryByText("Codex")).toBeNull();
  });
});

describe("WorkerHeader responsive-hide hooks (panel controls must never clip)", () => {
  it("gives the status badge and the background chip droppable classes so the far-right controls stay reachable on a narrow pane", () => {
    // jsdom can't evaluate the @container rules; lock the CONTRACT instead — the two newest header items carry the
    // same responsive-hide hooks the CSS drops, so they can no longer push the ml-auto controls past overflow:hidden.
    const { container } = render(<WorkerHeader {...baseProps} worker={{ id: "w1", label: "t", repoPath: "/r", status: "background", branch: null, model: null, bg: { count: 1, types: ["local_bash"] }, tasks: [{ id: "b1", type: "local_bash", description: "npm test" }] } as never} />);
    expect(screen.getByText("백그라운드 작업 중").closest(".workspace-header-status")).not.toBeNull();
    expect(screen.getByText("백그라운드 · 1").closest(".workspace-header-activity")).not.toBeNull();
    expect(container.querySelector(".workspace-header-controls")).not.toBeNull(); // controls keep their stable hook (never in a hide-set)
  });
});

describe("SessionHeader provider badge (Codex) — interop QW1", () => {
  it("renders a 'Codex' badge when the master session's provider is codex", () => {
    render(<SessionHeader {...baseProps} name="s" sessionId="s1" cwd="/r" readOnly={false} running={false} termPageKey="p1" provider="codex" />);
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });
  it("renders no badge for a claude/absent-provider session", () => {
    render(<SessionHeader {...baseProps} name="s" sessionId="s1" cwd="/r" readOnly={false} running={false} termPageKey="p1" />);
    expect(screen.queryByText("Codex")).toBeNull();
  });
});

describe("WorkerHeader terminology (reserved-word contract)", () => {
  beforeEach(() => { usePrefsStore.setState({ localePref: "system" }); });
  it("labels a worker 'Worker', never the reserved 'Agent'", () => {
    render(
      <I18nProvider systemLocale="en-US">
        <WorkerHeader {...baseProps} worker={{ id: "w3", label: "demo", repoPath: "/r", status: "running", branch: "rookery/a0", model: null } as never} />
      </I18nProvider>,
    );
    expect(screen.queryByText("Agent")).toBeNull();
    expect(screen.getByText("Worker")).toBeInTheDocument();
  });
});

// audit #48: dock mode used to hide the terminal/right-panel header toggles
// entirely. In dock mode they're restored, but now drive dockPanelsStore
// (the actual dockview panel add/remove is WorkspaceDock's job, covered by a
// live check — this only pins that the header wires the right store calls).
describe("HeaderControls dock-mode toggles (audit #48)", () => {
  beforeEach(() => { useDockPanelsStore.setState({ hiddenByPage: {}, autoHiddenByPage: {} }); });

  it("SessionHeader (master): legacy toggle buttons are absent in dock mode, dock toggles are present instead", () => {
    render(<SessionHeader {...baseProps} name="s" sessionId="s1" cwd="/r" readOnly={false} running={false} termPageKey="p1" dock />);
    // Both dock buttons share aria-labels with the legacy ones — only one of each should render.
    expect(screen.getAllByLabelText("터미널")).toHaveLength(1);
    expect(screen.getAllByLabelText("우측 패널")).toHaveLength(1);
  });

  it("SessionHeader (master): terminal toggle hides/shows only the terminal panel", () => {
    render(<SessionHeader {...baseProps} name="s" sessionId="s1" cwd="/r" readOnly={false} running={false} termPageKey="p1" dock />);
    fireEvent.click(screen.getByLabelText("터미널"));
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual(["terminal"]);
    fireEvent.click(screen.getByLabelText("터미널"));
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual([]);
  });

  it("SessionHeader (master): right-panel toggle hides/shows files+git as one group (no nested — master pages never seed it)", () => {
    render(<SessionHeader {...baseProps} name="s" sessionId="s1" cwd="/r" readOnly={false} running={false} termPageKey="p1" dock />);
    fireEvent.click(screen.getByLabelText("우측 패널"));
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual(["files", "git"]);
    fireEvent.click(screen.getByLabelText("우측 패널"));
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual([]);
  });

  it("WorkerHeader: right-panel toggle's group includes nested", () => {
    render(<WorkerHeader {...baseProps} termPageKey="w1" dock worker={{ id: "w1", label: "t", repoPath: "/r", status: "running", branch: "rookery/a0", model: null } as never} />);
    fireEvent.click(screen.getByLabelText("우측 패널"));
    expect(useDockPanelsStore.getState().hiddenByPage.w1).toEqual(["files", "git", "nested"]);
  });
});

// audit #4 #11: the toggles say what they will do and whether the panel is open.
describe("HeaderControls dock-mode toggle state (audit #4 #11)", () => {
  beforeEach(() => { useDockPanelsStore.setState({ hiddenByPage: {}, autoHiddenByPage: {} }); });
  const renderSession = () => render(<SessionHeader {...baseProps} name="s" sessionId="s1" cwd="/r" readOnly={false} running={false} termPageKey="p1" dock />);

  it("terminal toggle exposes aria-pressed and a verb tooltip that follows the state", () => {
    renderSession();
    const btn = screen.getByLabelText("터미널");
    expect(btn).toHaveAttribute("aria-pressed", "true");
    // audit #140 (intentional change): the tooltip now names the Ctrl+` shortcut it already had
    expect(btn).toHaveAttribute("title", "터미널 닫기 (Ctrl+`)");
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(btn).toHaveAttribute("title", "터미널 열기 (Ctrl+`)");
  });

  it("right toggle stays on while Files is still showing with Git closed, and a click hides the rest (audit #8)", () => {
    useDockPanelsStore.setState({ hiddenByPage: { p1: ["git"] }, autoHiddenByPage: {} });
    renderSession();
    const btn = screen.getByLabelText("우측 패널");
    expect(btn).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(btn);
    expect(useDockPanelsStore.getState().hiddenByPage.p1).toEqual(["git", "files"]);
  });

  it("a panel hidden by the narrow window reads as 'auto', not as closed, and a click opens it", () => {
    useDockPanelsStore.setState({ hiddenByPage: { p1: [] }, autoHiddenByPage: { p1: ["files", "git"] } });
    renderSession();
    const btn = screen.getByLabelText("우측 패널");
    expect(btn).toHaveAttribute("aria-pressed", "false");
    expect(btn).toHaveAttribute("data-state", "auto");
    expect(btn).toHaveAttribute("title", "창이 좁아서 파일·Git·활동을 숨겼어요 — 클릭하면 열려요");
    fireEvent.click(btn);
    expect(useDockPanelsStore.getState().autoHiddenByPage.p1).toEqual([]);
    expect(btn).toHaveAttribute("data-state", "open");
  });
});

// audit #57: the "Reset layout" header control only needs to clear this page's saved layout — the live
// dockview wipe+reseed is WorkspaceDock's own layoutStore subscription (verified live, same as #48 above).
describe("HeaderControls reset-layout button (audit #57)", () => {
  beforeEach(() => { useLayoutStore.setState({ ...emptyLayoutState(), resetSeq: {} }); });

  it("is absent outside dock mode", () => {
    render(<SessionHeader {...baseProps} name="s" sessionId="s1" cwd="/r" readOnly={false} running={false} termPageKey="p1" />);
    expect(screen.queryByLabelText("레이아웃 초기화")).toBeNull();
  });

  it("SessionHeader (dock mode): clears only the current page's saved layout", () => {
    useLayoutStore.getState().save_("p1", { grid: 1 });
    useLayoutStore.getState().save_("other-page", { grid: 2 });
    render(<SessionHeader {...baseProps} name="s" sessionId="s1" cwd="/r" readOnly={false} running={false} termPageKey="p1" dock />);
    fireEvent.click(screen.getByLabelText("레이아웃 초기화"));
    expect(useLayoutStore.getState().byPage.p1).toBeUndefined();
    expect(useLayoutStore.getState().byPage["other-page"]).toEqual({ grid: 2 });
    expect(useLayoutStore.getState().resetSeq.p1).toBe(1); // the live dock reseeds on this, saved layout or not (audit #81)
  });

  it("WorkerHeader (dock mode): reset button targets the worker's page key", () => {
    useLayoutStore.getState().save_("w1", { grid: 1 });
    render(<WorkerHeader {...baseProps} termPageKey="w1" dock worker={{ id: "w1", label: "t", repoPath: "/r", status: "running", branch: "rookery/a0", model: null } as never} />);
    fireEvent.click(screen.getByLabelText("레이아웃 초기화"));
    expect(useLayoutStore.getState().byPage.w1).toBeUndefined();
  });
});

// audit #22: both headers use one control order — metrics → (worker) checkpoint → Open in → overflow → reset →
// terminal → right panel — so the panel toggles never jump when switching between a session and a worker.
describe("header control order (audit #22)", () => {
  beforeEach(() => { useDockPanelsStore.setState({ hiddenByPage: {}, autoHiddenByPage: {} }); });
  const order = (container: HTMLElement): string[] =>
    Array.from(container.querySelector(".workspace-header-controls")!.children).map((el) =>
      (el as HTMLElement).className.match(/workspace-header-(metrics|checkpoint|overflow|reset)/)?.[1] ?? el.getAttribute("aria-label") ?? el.tagName.toLowerCase());

  it("session and worker headers end with the same reset → terminal → right panel run, metrics first", () => {
    const s = render(<SessionHeader {...baseProps} name="s" sessionId="s1" cwd="/r" readOnly={false} running={false} termPageKey="p1" dock />);
    const sessionOrder = order(s.container);
    s.unmount();
    const w = render(<WorkerHeader {...baseProps} termPageKey="w1" dock worker={{ id: "w1", label: "t", repoPath: "/r", status: "running", branch: "rookery/a0", model: null } as never} />);
    const workerOrder = order(w.container);
    expect(sessionOrder[0]).toBe("metrics");
    expect(workerOrder.slice(0, 2)).toEqual(["metrics", "checkpoint"]);
    expect(sessionOrder.slice(-4)).toEqual(["overflow", "reset", "터미널", "우측 패널"]);
    expect(workerOrder.slice(-4)).toEqual(["overflow", "reset", "터미널", "우측 패널"]);
  });
});

// audit #21: below 720px the header drops metrics, checkpoint, ticket, the background-task menu and Reset layout —
// a "…" overflow menu (shown only at that width, via the container query) keeps every one of them reachable.
describe("header overflow menu (audit #21)", () => {
  beforeEach(() => { useLayoutStore.setState({ ...emptyLayoutState(), resetSeq: {} }); useDockPanelsStore.setState({ hiddenByPage: {}, autoHiddenByPage: {} }); });
  const tasks = [{ id: "b1", type: "local_bash", description: "npm test --watch" }];

  it("worker: lists checkpoint restore, task stops, the ticket and Reset layout", () => {
    const onStopTask = vi.fn();
    const onFetchCheckpoints = vi.fn(async () => []);
    render(<WorkerHeader {...baseProps} termPageKey="w1" dock onStopTask={onStopTask} onFetchCheckpoints={onFetchCheckpoints} worker={{ id: "w1", label: "t", repoPath: "/r", status: "running", branch: "rookery/eng-1", model: null, ticketKey: "ENG-1", ticketUrl: "https://l/ENG-1", tasks } as never} />);
    fireEvent.click(screen.getByRole("button", { name: "더보기" }));
    const labels = screen.getAllByRole("menuitem").map((el) => el.textContent);
    expect(labels).toEqual(["체크포인트로 복원…", "중지: npm test --watchlocal_bash", "티켓 열기: ENG-1", "레이아웃 초기화"]);
    fireEvent.click(screen.getByRole("menuitem", { name: /중지: npm test/ }));
    expect(onStopTask).toHaveBeenCalledWith("b1");
  });

  it("worker: the checkpoint item opens the checkpoint menu", async () => {
    const onFetchCheckpoints = vi.fn(async () => [{ seq: 0, sha: "a", createdAt: "2026-06-20T10:00:00Z" }]);
    render(<WorkerHeader {...baseProps} termPageKey="w1" dock onFetchCheckpoints={onFetchCheckpoints} worker={{ id: "w1", label: "t", repoPath: "/r", status: "running", branch: null, model: null } as never} />);
    fireEvent.click(screen.getByRole("button", { name: "더보기" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "체크포인트로 복원…" }));
    expect(onFetchCheckpoints).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("턴 1")).toBeInTheDocument();
  });

  it("session: shows the metrics and Reset layout, and Reset layout clears this page's layout", () => {
    useLayoutStore.getState().save_("p1", { grid: 1 });
    useStore.setState({ logsBySession: { s1: [{ kind: "metrics", contextPct: 42, tokens: 1000, turns: 3, cost: 0.5 }] }, sessions: [] } as never);
    render(<SessionHeader {...baseProps} name="s" sessionId="s1" cwd="/r" readOnly={false} running={false} termPageKey="p1" dock />);
    fireEvent.click(screen.getByRole("button", { name: "더보기" }));
    const menu = screen.getByRole("menu");
    expect(menu).toHaveTextContent("42%");
    expect(menu).toHaveTextContent("1.0k 토큰");
    fireEvent.click(screen.getByRole("menuitem", { name: "레이아웃 초기화" }));
    expect(useLayoutStore.getState().byPage.p1).toBeUndefined();
  });

  // review m1: in the legacy (non-dock) layout a session has no Reset layout; with no metrics yet the menu would be empty.
  it("shows no '…' when there is nothing to put in it", () => {
    useStore.setState({ logsBySession: {}, sessions: [] } as never);
    render(<SessionHeader {...baseProps} name="s" sessionId="s1" cwd="/r" readOnly={false} running={false} termPageKey="p1" />);
    expect(screen.queryByRole("button", { name: "더보기" })).toBeNull();
  });

  it("keeps a short ctx% in the header itself: tokens/turns/cost carry the droppable class, ctx does not", () => {
    useStore.setState({ logsBySession: { s1: [{ kind: "metrics", contextPct: 42, tokens: 1000, turns: 3, cost: 0.5 }] }, sessions: [] } as never);
    const { container } = render(<SessionHeader {...baseProps} name="s" sessionId="s1" cwd="/r" readOnly={false} running={false} termPageKey="p1" dock />);
    const metrics = container.querySelector(".workspace-header-metrics")!;
    expect(metrics.querySelector(".metrics-secondary")).not.toBeNull();
    expect(Array.from(metrics.querySelectorAll(".metrics-secondary")).some((el) => el.textContent?.includes("%"))).toBe(false);
  });
});
