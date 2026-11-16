import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, act, fireEvent } from "@testing-library/react";
import { TerminalPanel } from "../src/renderer/components/TerminalPanel.js";

// xterm needs canvas/matchMedia, which jsdom lacks; these tests only care about which shells get opened.
vi.mock("../src/renderer/components/TerminalView.js", () => ({ TerminalView: () => null }));
import { useTermStore } from "../src/renderer/store/terminals.js";

afterEach(() => {
  cleanup();
  useTermStore.setState({ byPage: {}, layout: {} }); // isolate pages between tests (persist middleware keeps state across renders)
});

// audit #49b: the empty-state hint said "session's working folder" even on worker
// pages, where the panel actually starts in the worker's worktree (App.tsx passes
// subId, cwd=undefined for worker pages — main resolves the worktree cwd from
// ROOKERY_HOME+subId). useT() falls back to ko without a provider, matching the
// other no-provider component tests in this suite.
describe("TerminalPanel empty-state hint (audit #49b)", () => {
  it("master page (no subId): mentions the session's working folder", () => {
    render(<TerminalPanel sessionId="s1" subId={null} cwd="/repo" dock />);
    expect(screen.getByText("＋ 로 터미널을 여세요 — 세션 작업 폴더에서 시작해요.")).toBeInTheDocument();
  });

  it("worker page (subId set): mentions the worker's worktree instead", () => {
    render(<TerminalPanel sessionId="w1" subId="w1" dock />);
    expect(screen.getByText("＋ 로 터미널을 여세요 — 워커 워크트리에서 시작해요.")).toBeInTheDocument();
  });
});

// audit #80: one press of the terminal toggle / Ctrl+` should give a prompt (the dock asks via requestShell_), and a
// double click on "New terminal" must not spawn two shells.
describe("TerminalPanel shell requests and in-flight guard (audit #80)", () => {
  const setup = () => {
    let resolve!: (v: { id: string }) => void;
    const create = vi.fn(() => new Promise<{ id: string }>((r) => { resolve = r; }));
    (window as unknown as { rookery: unknown }).rookery = { term: { create, kill: vi.fn() } };
    return { create, finish: (id: string) => resolve({ id }) };
  };
  afterEach(() => { useTermStore.setState({ shellRequests: {} }); });

  it("opens one shell when the dock requests it", async () => {
    const { create, finish } = setup();
    render(<TerminalPanel sessionId="s1" subId={null} cwd="/repo" dock />);
    expect(create).not.toHaveBeenCalled();
    act(() => useTermStore.getState().requestShell_("s1"));
    expect(create).toHaveBeenCalledTimes(1);
    await act(async () => finish("t1"));
    expect(useTermStore.getState().byPage.s1?.tabs.map((x) => x.id)).toEqual(["t1"]);
  });

  it("honours a request made before the panel mounted (the toggle adds the panel and asks in one go)", () => {
    const { create } = setup();
    act(() => useTermStore.getState().requestShell_("s2"));
    render(<TerminalPanel sessionId="s2" subId={null} cwd="/repo" dock />);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("does not answer an old request again on a later mount", () => {
    const { create } = setup();
    act(() => useTermStore.getState().requestShell_("s3"));
    const first = render(<TerminalPanel sessionId="s3" subId={null} cwd="/repo" dock />);
    first.unmount();
    render(<TerminalPanel sessionId="s3" subId={null} cwd="/repo" dock />);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("a double click on New terminal spawns a single shell", () => {
    const { create } = setup();
    render(<TerminalPanel sessionId="s4" subId={null} cwd="/repo" dock />);
    const btn = screen.getByRole("button", { name: "새 터미널" });
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(create).toHaveBeenCalledTimes(1);
  });
});
