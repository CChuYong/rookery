import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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

describe("RightSidebar work-root resolution (audit #2)", () => {
  it("a terminal-status worker renders the workdirMissing message, not locating/skeleton", async () => {
    const ws = stubWs();
    useStore.setState({ fleet: fleetRow("orphaned") } as never);
    const { container } = render(<RightSidebar open pageKey="w1" subId="w1" cwd={undefined} activeTabPath={null} />);
    await waitFor(() => expect(screen.getByText("워크트리를 찾을 수 없어요 — 이미 삭제되었거나 재시작으로 세션이 종료됐어요.")).toBeInTheDocument());
    expect(container.querySelector(".sheen")).toBeNull();
    // A terminal status is a known dead end — no need to even ask the resolver.
    expect(ws.resolveRoot).not.toHaveBeenCalled();
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
