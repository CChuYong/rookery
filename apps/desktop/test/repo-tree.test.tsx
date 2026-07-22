import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RepoTree } from "../src/renderer/views/RepoTree.js";
import { useStore } from "../src/renderer/store/store.js";
import { useRepoTreeStore } from "../src/renderer/store/repotree.js";
import type { LogItem } from "../src/renderer/store/reduce.js";

const repo = { name: "app", path: "/code/app", description: "", base: null };
const worker = { id: "w1", label: "worker1", repoPath: "/code/app", status: "idle", branch: "rookery/w1", model: null, permissionMode: "bypassPermissions", ticketKey: null, ticketUrl: null };
// Still on the spawn-time repo-name placeholder (fleet-tools.ts spawns with label: repo.name) — never upgraded by
// the daemon's async task-summary relabel. This is the "wall of identical labels" case (audit #46).
const fallbackWorker = { id: "w2", label: "app", repoPath: "/code/app", status: "idle", branch: "rookery/w2", model: null, permissionMode: "bypassPermissions", ticketKey: null, ticketUrl: null };

describe("RepoTree repo-header affordances (audit #3, #19)", () => {
  it("opens repository settings with the authoritative repository id", () => {
    const onRepoSettings = vi.fn();
    render(
      <RepoTree
        repos={[{ ...repo, id: "repo-1" }]}
        fleet={[] as never}
        activeSubId={null}
        onSelectSub={() => {}}
        onNewRepo={() => {}}
        onRemoveRepo={() => {}}
        onNewSub={() => {}}
        onRepoSettings={onRepoSettings}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "app 설정" }));
    expect(onRepoSettings).toHaveBeenCalledWith("repo-1");
  });

  it("spawn (+) and remove (trash) buttons are always visible and expose their aria-labels", () => {
    render(
      <RepoTree
        repos={[repo] as never}
        fleet={[] as never}
        activeSubId={null}
        onSelectSub={() => {}}
        onNewRepo={() => {}}
        onRemoveRepo={() => {}}
        onNewSub={() => {}}
      />,
    );
    const spawnBtn = screen.getByRole("button", { name: "워커 스폰…" });
    const removeBtn = screen.getByRole("button", { name: "레포 등록 해제" });
    // These are primary repo actions, so they should not depend on hover/focus reveal.
    expect(spawnBtn.className).not.toMatch(/\bhidden\b/);
    expect(removeBtn.className).not.toMatch(/\bhidden\b/);
    expect(spawnBtn.className).not.toMatch(/\bopacity-0\b/);
    expect(removeBtn.className).not.toMatch(/\bopacity-0\b/);
    expect(spawnBtn.className).not.toMatch(/\bgroup-hover:opacity-100\b/);
    expect(removeBtn.className).not.toMatch(/\bgroup-hover:opacity-100\b/);
    expect(spawnBtn).not.toHaveAttribute("disabled");
    expect(removeBtn).not.toHaveAttribute("disabled");
  });

  it("clicking + opens a worker in this repo via onNewSub", () => {
    const onNewSub = vi.fn();
    render(
      <RepoTree
        repos={[repo] as never}
        fleet={[] as never}
        activeSubId={null}
        onSelectSub={() => {}}
        onNewRepo={() => {}}
        onRemoveRepo={() => {}}
        onNewSub={onNewSub}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "워커 스폰…" }));
    expect(onNewSub).toHaveBeenCalledWith("app");
  });

  it("clicking trash does NOT call onRemoveRepo until the confirm dialog is confirmed", () => {
    const onRemoveRepo = vi.fn();
    render(
      <RepoTree
        repos={[repo] as never}
        fleet={[] as never}
        activeSubId={null}
        onSelectSub={() => {}}
        onNewRepo={() => {}}
        onRemoveRepo={onRemoveRepo}
        onNewSub={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "레포 등록 해제" }));
    expect(onRemoveRepo).not.toHaveBeenCalled();
    expect(screen.getByText("'app' 레포 등록을 해제할까요? 파일은 그대로 남아요.")).toBeInTheDocument();
  });

  it("confirming the remove dialog calls onRemoveRepo with the repo name", () => {
    const onRemoveRepo = vi.fn();
    render(
      <RepoTree
        repos={[repo] as never}
        fleet={[] as never}
        activeSubId={null}
        onSelectSub={() => {}}
        onNewRepo={() => {}}
        onRemoveRepo={onRemoveRepo}
        onNewSub={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "레포 등록 해제" }));
    // Two elements now say "레포 등록 해제": the header trash button and the dialog's confirm button.
    const matches = screen.getAllByText("레포 등록 해제");
    fireEvent.click(matches[matches.length - 1]!);
    expect(onRemoveRepo).toHaveBeenCalledWith("app");
  });

  it("cancelling the remove dialog leaves onRemoveRepo uncalled", () => {
    const onRemoveRepo = vi.fn();
    render(
      <RepoTree
        repos={[repo] as never}
        fleet={[] as never}
        activeSubId={null}
        onSelectSub={() => {}}
        onNewRepo={() => {}}
        onRemoveRepo={onRemoveRepo}
        onNewSub={() => {}}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "레포 등록 해제" }));
    fireEvent.click(screen.getByText("취소"));
    expect(onRemoveRepo).not.toHaveBeenCalled();
  });

  it("empty state mentions the + entry point", () => {
    render(
      <RepoTree
        repos={[] as never}
        fleet={[] as never}
        loaded
        activeSubId={null}
        onSelectSub={() => {}}
        onNewRepo={() => {}}
        onRemoveRepo={() => {}}
        onNewSub={() => {}}
      />,
    );
    expect(screen.getByText(/\+ 버튼으로 워커를 스폰할 수 있어요/)).toBeInTheDocument();
  });
});

describe("RepoTree worker-row overflow '⋯' button (audit #45)", () => {
  it("is reachable by role/name and opens the same menu as right-click (Rename/Fork visible)", () => {
    render(
      <RepoTree
        repos={[repo] as never}
        fleet={[worker] as never}
        activeSubId={null}
        onSelectSub={() => {}}
        onNewRepo={() => {}}
        onRemoveRepo={() => {}}
        onNewSub={() => {}}
        onRenameSub={vi.fn()}
        onForkSub={vi.fn()}
        onArchiveSub={vi.fn()}
        onDeleteSub={vi.fn()}
      />,
    );
    const moreBtn = screen.getByRole("button", { name: "더보기" });
    fireEvent.click(moreBtn);
    expect(screen.getByText("이름 변경")).toBeInTheDocument();
    expect(screen.getByText("포크")).toBeInTheDocument();
  });

  it("clicking a menu item opened via '⋯' invokes the corresponding callback", () => {
    const onForkSub = vi.fn();
    render(
      <RepoTree
        repos={[repo] as never}
        fleet={[worker] as never}
        activeSubId={null}
        onSelectSub={() => {}}
        onNewRepo={() => {}}
        onRemoveRepo={() => {}}
        onNewSub={() => {}}
        onForkSub={onForkSub}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "더보기" }));
    fireEvent.click(screen.getByText("포크"));
    expect(onForkSub).toHaveBeenCalledWith("w1");
  });
});

describe("RepoTree fallback-label disambiguating subline (audit #46)", () => {
  beforeEach(() => useStore.setState({ workerLogs: {} }));

  it("a worker still on the repo-name placeholder shows a relative-time subline once its log has loaded", () => {
    useStore.setState({ workerLogs: { w2: [{ kind: "message", role: "assistant", content: "hi", ts: Date.now() } as LogItem] } });
    render(
      <RepoTree
        repos={[repo] as never}
        fleet={[fallbackWorker] as never}
        activeSubId={null}
        onSelectSub={() => {}}
        onNewRepo={() => {}}
        onRemoveRepo={() => {}}
        onNewSub={() => {}}
      />,
    );
    expect(screen.getByText("방금")).toBeInTheDocument();
  });

  it("a fallback-labeled worker whose log hasn't loaded yet shows no subline (no fetch is triggered)", () => {
    render(
      <RepoTree
        repos={[repo] as never}
        fleet={[fallbackWorker] as never}
        activeSubId={null}
        onSelectSub={() => {}}
        onNewRepo={() => {}}
        onRemoveRepo={() => {}}
        onNewSub={() => {}}
      />,
    );
    expect(screen.queryByText("방금")).toBeNull();
  });

  it("a worker with a real (non-repo-name) label stays single-line even with recent activity", () => {
    useStore.setState({ workerLogs: { w1: [{ kind: "message", role: "assistant", content: "hi", ts: Date.now() } as LogItem] } });
    render(
      <RepoTree
        repos={[repo] as never}
        fleet={[worker] as never} // worker.label = "worker1" ≠ repo.name "app" → not a fallback
        activeSubId={null}
        onSelectSub={() => {}}
        onNewRepo={() => {}}
        onRemoveRepo={() => {}}
        onNewSub={() => {}}
      />,
    );
    expect(screen.queryByText("방금")).toBeNull();
  });

  it("shows the subline from the fleet lastActivityTs with NO log loaded (no open needed)", () => {
    // workerLogs is empty (beforeEach) — the time comes purely from the fleet.list snapshot
    render(
      <RepoTree
        repos={[repo] as never}
        fleet={[{ ...fallbackWorker, lastActivityTs: Date.now() }] as never}
        activeSubId={null}
        onSelectSub={() => {}} onNewRepo={() => {}} onRemoveRepo={() => {}} onNewSub={() => {}}
      />,
    );
    expect(screen.getByText("방금")).toBeInTheDocument();
  });
});

// Audit #50: the tree's status tag is a deliberate colorblind-safe abbreviation (kept short — "ORPH"), but it must
// carry the SAME full-word label as the header StatusBadge via its title, so the two never disagree.
describe("RepoTree status tag full-word title (audit #50)", () => {
  it("shows the short colorblind tag but titles it with the full localized state name", () => {
    const orphanedWorker = { ...worker, id: "w3", status: "orphaned" };
    render(
      <RepoTree
        repos={[repo] as never}
        fleet={[orphanedWorker] as never}
        activeSubId={null}
        onSelectSub={() => {}}
        onNewRepo={() => {}}
        onRemoveRepo={() => {}}
        onNewSub={() => {}}
      />,
    );
    const tag = screen.getByText("ORPH");
    expect(tag).toHaveAttribute("title", "유실됨"); // same full word the header StatusBadge shows for this status
  });
});

// Final-review F1: the absolutely-positioned '⋯' overflow button (audit #45) paints over the right-side
// cluster (cost/tag/unread) and sits above it in hit-testing, making the tag's title unreachable on hover.
// Mirrors Sessions.tsx's OriginBadge/unread-dot hover-yield idiom — pin the classes so the fade stays wired up.
describe("RepoTree right-side cluster yields to the '⋯' button on hover (final-review F1)", () => {
  it("the status tag fades out on row hover so the '⋯' button doesn't collide with it", () => {
    render(
      <RepoTree
        repos={[repo] as never}
        fleet={[worker] as never}
        activeSubId={null}
        onSelectSub={() => {}}
        onNewRepo={() => {}}
        onRemoveRepo={() => {}}
        onNewSub={() => {}}
      />,
    );
    const tag = screen.getByText("IDLE");
    expect(tag.className).toMatch(/\btransition-opacity\b/);
    expect(tag.className).toMatch(/\bgroup-hover:opacity-0\b/);
  });
});

describe("RepoTree provider badge (Codex)", () => {
  it("shows a 'Codex' badge on a fleet row whose provider is codex", () => {
    render(
      <RepoTree
        repos={[repo] as never}
        fleet={[{ ...worker, id: "w4", provider: "codex" }] as never}
        activeSubId={null}
        onSelectSub={() => {}} onNewRepo={() => {}} onRemoveRepo={() => {}} onNewSub={() => {}}
      />,
    );
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });

  it("shows no badge on a fleet row whose provider is absent (claude default)", () => {
    render(
      <RepoTree
        repos={[repo] as never}
        fleet={[worker] as never}
        activeSubId={null}
        onSelectSub={() => {}} onNewRepo={() => {}} onRemoveRepo={() => {}} onNewSub={() => {}}
      />,
    );
    expect(screen.queryByText("Codex")).toBeNull();
  });
});

// The sidebar renders RepoTree ⟷ Sessions conditionally (App.tsx), so a Sessions↔Repos tab switch
// unmounts the tree. Fold state therefore lives in the persisted useRepoTreeStore — it must survive
// a full unmount+remount (and, via localStorage, an app restart).
describe("RepoTree fold state survives unmount/remount (tab switch)", () => {
  const treeProps = {
    repos: [repo] as never,
    fleet: [worker] as never,
    activeSubId: null,
    onSelectSub: () => {},
    onNewRepo: () => {},
    onRemoveRepo: () => {},
    onNewSub: () => {},
  };
  // The store is module-global — reset on BOTH sides so fold state can't leak into other describes
  // in this file (they render the same tree and assume everything is expanded).
  const reset = () => {
    localStorage.clear();
    useRepoTreeStore.setState({ collapsed: {}, archOpen: false });
  };
  beforeEach(reset);
  afterEach(reset);

  it("a collapsed repo group stays collapsed after remount", () => {
    const first = render(<RepoTree {...treeProps} />);
    expect(screen.getByText("worker1")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "app 1" })); // fold the repo group
    first.unmount();
    render(<RepoTree {...treeProps} />);
    // Collapse's lazy render-latch: a group mounted closed renders no children at all.
    expect(screen.queryByText("worker1")).toBeNull();
  });

  it("re-expanding before the switch is also remembered", () => {
    const first = render(<RepoTree {...treeProps} />);
    fireEvent.click(screen.getByRole("button", { name: "app 1" }));
    fireEvent.click(screen.getByRole("button", { name: "app 1" })); // expand again
    first.unmount();
    render(<RepoTree {...treeProps} />);
    expect(screen.getByText("worker1")).toBeInTheDocument();
  });

  it("the archive section's open state survives remount", () => {
    const props = { ...treeProps, fleet: [{ ...worker, archived: true }] as never };
    const first = render(<RepoTree {...props} />);
    expect(screen.queryByText("worker1")).toBeNull(); // archive starts closed
    fireEvent.click(screen.getByRole("button", { name: /보관함/ }));
    expect(screen.getByText("worker1")).toBeInTheDocument();
    first.unmount();
    render(<RepoTree {...props} />);
    expect(screen.getByText("worker1")).toBeInTheDocument();
  });

  it("prunes fold keys of repos that no longer exist once repos are known", () => {
    useRepoTreeStore.setState({ collapsed: { "removed-repo": true, app: true } });
    render(<RepoTree {...treeProps} />);
    expect(useRepoTreeStore.getState().collapsed).toEqual({ app: true });
  });
});

describe("RepoTree fleet-provided cost (no open needed)", () => {
  beforeEach(() => useStore.setState({ workerLogs: {} }));

  it("shows a worker's cost from the fleet costUsd with no log loaded", () => {
    render(
      <RepoTree
        repos={[repo] as never}
        fleet={[{ ...worker, costUsd: 2.5 }] as never}
        activeSubId={null}
        onSelectSub={() => {}} onNewRepo={() => {}} onRemoveRepo={() => {}} onNewSub={() => {}}
      />,
    );
    // With a single fleet worker, the FleetBurn total is numerically identical to this row's cost (both $2.50) —
    // scope to the per-row WorkerCost span via its title so this asserts the row, not the (also-correct) burn total.
    expect(screen.getByTitle("이 워커의 누적 비용")).toHaveTextContent("$2.50");
  });

  it("the fleet-burn total sums fleet costUsd across workers even when none are opened", () => {
    render(
      <RepoTree
        repos={[repo] as never}
        fleet={[{ ...worker, costUsd: 2.5 }, { ...fallbackWorker, costUsd: 1.25 }] as never}
        activeSubId={null}
        onSelectSub={() => {}} onNewRepo={() => {}} onRemoveRepo={() => {}} onNewSub={() => {}}
      />,
    );
    expect(screen.getByText("$3.75")).toBeInTheDocument();
  });
});

// The worker state graph added `background` (turn ended, harness-tracked background tasks still running).
// Both affordances below were gated to running/idle and silently excluded it.
describe("RepoTree background-state affordances", () => {
  const bgWorker = { ...worker, id: "wbg", label: "workflow worker", status: "background", branch: "rookery/wbg" };

  it("offers Stop for a background worker — fleet.stop is the only control that kills background tasks", () => {
    const onStopSub = vi.fn();
    render(
      <RepoTree
        repos={[repo] as never}
        fleet={[bgWorker] as never}
        activeSubId={null}
        onSelectSub={() => {}} onNewRepo={() => {}} onRemoveRepo={() => {}} onNewSub={() => {}}
        onStopSub={onStopSub}
      />,
    );
    fireEvent.contextMenu(screen.getByText("workflow worker"));
    fireEvent.click(screen.getByText("종료")); // repoTree.menuStop, now "End" (ko 종료) — the terminal tree action
    expect(onStopSub).toHaveBeenCalledWith("wbg");
  });

  it("labels the terminal tree Stop as '종료' (not the soft-sounding '중단') and shows reversibility hints on End + Delete", () => {
    render(
      <RepoTree
        repos={[repo] as never}
        fleet={[{ ...worker, id: "wx", label: "legible worker", status: "idle" }] as never}
        activeSubId={null}
        onSelectSub={() => {}} onNewRepo={() => {}} onRemoveRepo={() => {}} onNewSub={() => {}}
        onStopSub={vi.fn()} onDeleteSub={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByText("legible worker"));
    expect(screen.getByText("종료")).toBeInTheDocument();
    expect(screen.queryByText("중단")).toBeNull(); // the tree's terminal action no longer collides with the composer's soft "중단"
    expect(screen.getByText(/재시작 시 복구/)).toBeInTheDocument(); // End: reversible
    expect(screen.getByText(/되돌릴 수 없/)).toBeInTheDocument(); // Delete: irreversible
  });

  it("keeps a background worker visible under the active/live filter", () => {
    // The filter bar only renders past 4 non-archived rows, so pad with settled workers — which also lets this
    // assert the filter still does its job (the stopped ones go away, the background one stays).
    const settled = [0, 1, 2, 3].map((i) => ({ ...worker, id: `ws${i}`, label: `settled ${i}`, status: "stopped" }));
    render(
      <RepoTree
        repos={[repo] as never}
        fleet={[bgWorker, ...settled] as never}
        activeSubId={null}
        onSelectSub={() => {}} onNewRepo={() => {}} onRemoveRepo={() => {}} onNewSub={() => {}}
      />,
    );
    fireEvent.click(screen.getByText("활성")); // repoTree.onlyActive — rendered as "live" in the en catalog
    expect(screen.getByText("workflow worker")).toBeInTheDocument();
    expect(screen.queryByText("settled 0")).not.toBeInTheDocument();
  });
});
