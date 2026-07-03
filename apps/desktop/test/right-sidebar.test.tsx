import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import { RightSidebar } from "../src/renderer/components/RightSidebar.js";
import { useStore } from "../src/renderer/store/store.js";
import { useWsStore } from "../src/renderer/store/workspace.js";

function stubWs(over: Record<string, unknown> = {}) {
  const ws = {
    resolveRoot: vi.fn(async () => "/home/user"),
    watchTree: vi.fn(),
    onTree: vi.fn(() => () => {}),
    unwatchTree: vi.fn(),
    list: vi.fn(async () => []),
    gitStatus: vi.fn(async () => []),
    walk: vi.fn(async () => ({ paths: [], truncated: false })),
    ...over,
  };
  (window as unknown as { rookery: unknown }).rookery = { ws };
  return ws;
}

function fleetRow(status: string) {
  return { w1: { id: "w1", label: "worker", repoPath: "/repo", status, branch: null, model: null, permissionMode: "bypassPermissions" } };
}

beforeEach(() => {
  useStore.setState({ fleet: {}, nested: {}, workerLogs: {} } as never);
  useWsStore.setState({ byPage: {}, expandedByPage: {}, right: { open: true, width: 300, segment: "files" } });
});

describe("RightSidebar work-root resolution (audit #2, task 11 review)", () => {
  it("a terminal-status worker whose worktree still resolves renders the Files panel, not workdirMissing", async () => {
    // stopped/done/error/orphaned usually still HAVE a worktree (only discard_worker removes it) — the whole
    // point of the terminal state is "review the diff, then decide", so a matching resolve must render ready.
    const ws = stubWs({ resolveRoot: vi.fn(async () => "/wt/w1"), list: vi.fn(async () => [{ name: "a.ts", isDir: false }]) });
    useStore.setState({ fleet: fleetRow("stopped") } as never);
    render(<RightSidebar open pageKey="w1" subId="w1" cwd={undefined} activeTabPath={null} />);
    await screen.findByText("a.ts");
    expect(screen.queryByText(/워크트리를 찾을 수 없어요/)).toBeNull();
    // Exactly one resolve attempt — a terminal status either has a worktree now or never will, no 15x retry loop.
    expect(ws.resolveRoot).toHaveBeenCalledTimes(1);
  });

  it("a terminal-status worker whose worktree is really gone (home-dir fallback) renders workdirMissing", async () => {
    const ws = stubWs(); // resolveRoot falls back to /home/user, which never ends with "w1"
    useStore.setState({ fleet: fleetRow("orphaned") } as never);
    const { container } = render(<RightSidebar open pageKey="w1" subId="w1" cwd={undefined} activeTabPath={null} />);
    await waitFor(() => expect(screen.getByText("워크트리를 찾을 수 없어요 — 이미 삭제되었거나 재시작으로 세션이 종료됐어요.")).toBeInTheDocument());
    expect(container.querySelector(".sheen")).toBeNull();
    // Still just one resolve attempt (no retry loop for a terminal status), the single answer settles it.
    expect(ws.resolveRoot).toHaveBeenCalledTimes(1);
  });

  it("a ready worker whose status flips to a terminal one stays ready (no live blank-out)", async () => {
    // Stopping the worker you're currently watching must not flip a WORKING panel to workdirMissing.
    const ws = stubWs({ resolveRoot: vi.fn(async () => "/wt/w1"), list: vi.fn(async () => [{ name: "a.ts", isDir: false }]) });
    useStore.setState({ fleet: fleetRow("running") } as never);
    render(<RightSidebar open pageKey="w1" subId="w1" cwd={undefined} activeTabPath={null} />);
    await screen.findByText("a.ts");
    expect(ws.resolveRoot).toHaveBeenCalledTimes(1);
    act(() => { useStore.setState({ fleet: fleetRow("stopped") } as never); });
    expect(screen.getByText("a.ts")).toBeInTheDocument();
    expect(screen.queryByText(/워크트리를 찾을 수 없어요/)).toBeNull();
    // The transition to terminal didn't trigger a re-verification — the already-ready root is trusted as is.
    expect(ws.resolveRoot).toHaveBeenCalledTimes(1);
  });

  it("a non-terminal status that hasn't resolved yet shows a skeleton, not the missing message", async () => {
    const ws = stubWs(); // resolveRoot falls back to /home/user, which never ends with "w1"
    useStore.setState({ fleet: fleetRow("running") } as never);
    const { container } = render(<RightSidebar open pageKey="w1" subId="w1" cwd={undefined} activeTabPath={null} />);
    expect(container.querySelector(".sheen")).not.toBeNull();
    // Let the in-flight resolveRoot() settle (still non-terminal → schedules a retry, stays on the skeleton).
    await waitFor(() => expect(ws.resolveRoot).toHaveBeenCalled());
    expect(container.querySelector(".sheen")).not.toBeNull();
    expect(screen.queryByText(/워크트리를 찾을 수 없어요/)).toBeNull();
  });

  it("renders the Files panel once the root resolves to the worker's actual worktree", async () => {
    stubWs({ resolveRoot: vi.fn(async () => "/wt/w1"), list: vi.fn(async () => [{ name: "a.ts", isDir: false }]) });
    useStore.setState({ fleet: fleetRow("running") } as never);
    const { container } = render(<RightSidebar open pageKey="w1" subId="w1" cwd={undefined} activeTabPath={null} />);
    await screen.findByText("a.ts");
    expect(container.querySelector(".sheen")).toBeNull();
    expect(screen.queryByText(/워크트리를 찾을 수 없어요/)).toBeNull();
  });
});
