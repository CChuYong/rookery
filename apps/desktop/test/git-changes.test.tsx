import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { GitChanges } from "../src/renderer/components/GitChanges.js";
import { useWsStore } from "../src/renderer/store/workspace.js";
import { useToastStore } from "../src/renderer/store/toasts.js";

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

  // audit #84: once a worker commits, this panel is empty — the worker's whole-branch diff is one click away here.
  it("offers 'View branch diff' (header + empty state) only when the page is a worker", async () => {
    stubWs({ gitChanges: vi.fn(async () => []) });
    const onViewBranchDiff = vi.fn();
    const { unmount } = render(<GitChanges root="/r" pageKey="w1" onViewBranchDiff={onViewBranchDiff} />);
    await waitFor(() => expect(screen.getByText("변경 사항이 없어요.")).toBeInTheDocument());
    const entries = screen.getAllByRole("button", { name: "브랜치 전체 변경 보기" });
    expect(entries).toHaveLength(2);
    fireEvent.click(entries[1]!);
    expect(onViewBranchDiff).toHaveBeenCalledTimes(1);
    unmount();
    render(<GitChanges root="/r" pageKey="p1" />);
    await waitFor(() => expect(screen.getByText("변경 사항이 없어요.")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "브랜치 전체 변경 보기" })).toBeNull();
  });
  // audit #88: not a repository / git failure must not read as "no changes".
  it("a folder that isn't a git repository says so — no change list, commit box or History", async () => {
    stubWs({ gitInfo: vi.fn(async () => ({ isRepo: false })), gitChanges: vi.fn(async () => { throw new Error("fatal: not a git repository"); }) });
    render(<GitChanges root="/r" pageKey="p1" />);
    expect(await screen.findByText("이 폴더는 git 레포가 아니에요.")).toBeInTheDocument();
    expect(screen.queryByText("변경 사항이 없어요.")).toBeNull();
    expect(screen.queryByPlaceholderText(/커밋/)).toBeNull();
    expect(screen.queryByText("기록")).toBeNull();
  });

  it("a git failure shows the error with a retry, not an empty list", async () => {
    const gitChanges = vi.fn().mockRejectedValueOnce(new Error("index file corrupt")).mockResolvedValue([{ path: "src/app.ts", x: "M", y: " ", added: 1, deleted: 0 }]);
    stubWs({ gitChanges });
    render(<GitChanges root="/r" pageKey="p1" />);
    expect(await screen.findByText("Git 상태를 불러오지 못했어요")).toBeInTheDocument();
    expect(screen.getByText(/index file corrupt/)).toBeInTheDocument();
    expect(screen.queryByText("변경 사항이 없어요.")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText("app.ts")).toBeInTheDocument();
  });

  // Final review #6: a non-repo folder stops calling gitChanges (it only throws there); the poll keeps checking
  // gitInfo so a `git init` is picked up, and then changes load again.
  it("stops polling gitChanges in a folder that isn't a repository, and resumes once it becomes one", async () => {
    vi.useFakeTimers();
    let repo = false;
    const gitInfo = vi.fn(async () => (repo ? { branch: "main", ahead: 0, behind: 0, upstream: null } : { isRepo: false }));
    const gitChanges = vi.fn(async () => { if (!repo) throw new Error("fatal: not a git repository"); return [{ path: "a.ts", x: "?", y: "?", added: 0, deleted: 0 }]; });
    stubWs({ gitInfo, gitChanges });
    render(<GitChanges root="/r" pageKey="p1" />);
    await vi.advanceTimersByTimeAsync(0);
    const afterFirst = gitChanges.mock.calls.length;
    expect(afterFirst).toBeLessThanOrEqual(1); // the first read can't know yet
    await vi.advanceTimersByTimeAsync(2600 * 3);
    expect(gitChanges.mock.calls.length).toBe(afterFirst);
    expect(gitInfo.mock.calls.length).toBeGreaterThanOrEqual(4);
    repo = true;
    await vi.advanceTimersByTimeAsync(2600);
    expect(gitChanges.mock.calls.length).toBeGreaterThan(afterFirst);
    vi.useRealTimers();
    expect(await screen.findByText("a.ts")).toBeInTheDocument();
  });

  // Final review #10: a failed retry names the reason once (the detail line), not again in the retry note.
  it("a failed retry does not repeat the reason", async () => {
    const gitChanges = vi.fn().mockRejectedValue(new Error("index file corrupt"));
    stubWs({ gitChanges });
    render(<GitChanges root="/r" pageKey="p1" />);
    expect(await screen.findByText("Git 상태를 불러오지 못했어요")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(await screen.findByText(/다시 시도했지만/)).toBeInTheDocument();
    expect(screen.getAllByText(/index file corrupt/)).toHaveLength(1);
  });

  // audit #39: the chevron really collapses its section.
  it("section heads are real collapse toggles", async () => {
    render(<GitChanges root="/r" pageKey="p1" />);
    await waitFor(() => screen.getByText("app.ts"));
    const head = screen.getByRole("button", { name: /스테이지됨/ });
    expect(head).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(head);
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText("app.ts")).toBeNull();
    expect(screen.getByText("new.ts")).toBeInTheDocument(); // the other section is untouched
  });

  // audit #38: an untracked directory ("dir/") shows its name once, not "dir  dir".
  it("an untracked directory at the root shows its name once", async () => {
    stubWs({ gitChanges: vi.fn(async () => [{ path: ".omc/", x: "?", y: "?", added: 0, deleted: 0 }]) });
    render(<GitChanges root="/r" pageKey="p1" />);
    await waitFor(() => screen.getByText(".omc"));
    expect(screen.getAllByText(".omc")).toHaveLength(1);
  });

  // audit #41: Push shows progress, blocks row actions while busy, and confirms success.
  it("push shows progress, disables row actions meanwhile, and toasts where it pushed", async () => {
    let finish!: (v: { ok: boolean }) => void;
    const gitPush = vi.fn(() => new Promise<{ ok: boolean }>((res) => { finish = res; }));
    stubWs({ gitPush });
    useToastStore.setState({ toasts: [] });
    render(<GitChanges root="/r" pageKey="p1" />);
    await waitFor(() => screen.getByText("app.ts"));
    const push = screen.getByRole("button", { name: "푸시" });
    fireEvent.click(push);
    expect(push).toHaveAttribute("aria-busy", "true");
    expect(screen.getByRole("button", { name: "언스테이지" })).toBeDisabled();
    finish({ ok: true });
    await waitFor(() => expect(useToastStore.getState().toasts.some((t) => t.text === "origin/feature-x에 푸시했어요")).toBe(true));
  });

  // #33 carry-over: disabled Commit / Push explain why.
  it("disabled Commit and Push say why in a tooltip", async () => {
    stubWs({ gitInfo: vi.fn(async () => ({ isRepo: true, branch: "feature-x", ahead: 0, behind: 0, upstream: "origin/feature-x", head: "a1" })) });
    render(<GitChanges root="/r" pageKey="p1" />);
    await waitFor(() => screen.getByText("app.ts"));
    const tips = screen.getAllByRole("tooltip").map((el) => el.textContent);
    expect(tips).toContain("커밋 메시지를 입력해 주세요");
    expect(tips).toContain("푸시할 커밋이 없어요");
  });

  // audit #40: History follows HEAD and the refresh button.
  it("History reloads when HEAD moves and on refresh", async () => {
    vi.useFakeTimers();
    let head = "a1";
    const gitInfo = vi.fn(async () => ({ isRepo: true, branch: "feature-x", ahead: 0, behind: 0, upstream: null, head }));
    const ws = stubWs({ gitInfo });
    render(<GitChanges root="/r" pageKey="p1" />);
    await vi.advanceTimersByTimeAsync(0);
    fireEvent.click(screen.getByText("기록"));
    await vi.advanceTimersByTimeAsync(0);
    const afterOpen = ws.gitLog.mock.calls.length;
    expect(afterOpen).toBeGreaterThan(0);
    head = "b2"; // a commit landed (worker or this panel)
    await vi.advanceTimersByTimeAsync(2600);
    expect(ws.gitLog.mock.calls.length).toBeGreaterThan(afterOpen);
    const afterHead = ws.gitLog.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "새로고침" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.gitLog.mock.calls.length).toBeGreaterThan(afterHead);
  });
});
