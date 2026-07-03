import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { GitChanges } from "../src/renderer/components/GitChanges.js";
import { useWsStore } from "../src/renderer/store/workspace.js";

function stubWs(over: Record<string, unknown> = {}) {
  const ws = {
    gitChanges: vi.fn(async () => [
      { path: "src/app.ts", x: "M", y: " ", added: 10, deleted: 2 }, // staged
      { path: "new.ts", x: "?", y: "?", added: 0, deleted: 0 }, // untracked → changed
    ]),
    gitInfo: vi.fn(async () => ({ branch: "feature-x", ahead: 2, behind: 0, upstream: "origin/feature-x" })),
    gitStage: vi.fn(async () => ({ ok: true })),
    gitUnstage: vi.fn(async () => ({ ok: true })),
    gitStageAll: vi.fn(async () => ({ ok: true })),
    gitDiscard: vi.fn(async () => ({ ok: true })),
    gitCommit: vi.fn(async () => ({ ok: true })),
    gitPush: vi.fn(async () => ({ ok: true })),
    gitLog: vi.fn(async () => [{ hash: "abc123", shortHash: "abc123", subject: "fix app", author: "CChuYonng", date: Math.floor(Date.now() / 1000) - 3600 }]),
    ...over,
  };
  (window as unknown as { rookery: unknown }).rookery = { ws };
  return ws;
}

describe("GitChanges", () => {
  beforeEach(() => stubWs());
  afterEach(() => vi.useRealTimers());

  it("polls git status while mounted (worktree commits auto-reflected)", async () => {
    vi.useFakeTimers();
    const ws = stubWs();
    render(<GitChanges root="/r" pageKey="p1" />);
    await vi.advanceTimersByTimeAsync(0); // flush initial load
    const initial = ws.gitChanges.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2600); // polling interval elapsed
    expect(ws.gitChanges.mock.calls.length).toBeGreaterThan(initial);
  });

  it("renders branch header + grouped staged/changes with numstat", async () => {
    render(<GitChanges root="/r" pageKey="p1" />);
    await waitFor(() => expect(screen.getByText("feature-x")).toBeInTheDocument());
    expect(screen.getByText(/스테이지됨/)).toBeInTheDocument(); // staged section
    expect(screen.getByText(/변경됨/)).toBeInTheDocument(); // unstaged/untracked section
    expect(screen.getByText("app.ts")).toBeInTheDocument();
    expect(screen.getAllByText("+10").length).toBeGreaterThan(0); // numstat (row + header total)
  });

  it("commit button: disabled until a message is typed; calls gitCommit", async () => {
    const ws = stubWs();
    render(<GitChanges root="/r" pageKey="p1" />);
    await waitFor(() => screen.getByText("app.ts"));
    const btn = screen.getByRole("button", { name: /커밋/ });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText(/커밋 메시지/), { target: { value: "fix app" } });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    await waitFor(() => expect(ws.gitCommit).toHaveBeenCalledWith("/r", "fix app"));
  });

  it("History tab lists commits; clicking a commit opens a commit tab", async () => {
    stubWs();
    render(<GitChanges root="/r" pageKey="pX" />);
    await waitFor(() => screen.getByText("기록"));
    fireEvent.click(screen.getByText("기록"));
    await waitFor(() => expect(screen.getByText("fix app")).toBeInTheDocument());
    fireEvent.click(screen.getByText("fix app"));
    const page = useWsStore.getState().byPage["pX"];
    expect(page?.tabs.some((t) => t.kind === "commit" && t.id === "commit:abc123")).toBe(true);
  });
});
