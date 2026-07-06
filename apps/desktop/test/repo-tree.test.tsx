import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RepoTree } from "../src/renderer/views/RepoTree.js";
import { useStore } from "../src/renderer/store/store.js";
import type { LogItem } from "../src/renderer/store/reduce.js";

const repo = { name: "app", path: "/code/app", description: "", base: null };
const worker = { id: "w1", label: "worker1", repoPath: "/code/app", status: "idle", branch: "rookery/w1", model: null, permissionMode: "bypassPermissions", ticketKey: null, ticketUrl: null };
// Still on the spawn-time repo-name placeholder (fleet-tools.ts spawns with label: repo.name) — never upgraded by
// the daemon's async task-summary relabel. This is the "wall of identical labels" case (audit #46).
const fallbackWorker = { id: "w2", label: "app", repoPath: "/code/app", status: "idle", branch: "rookery/w2", model: null, permissionMode: "bypassPermissions", ticketKey: null, ticketUrl: null };

describe("RepoTree repo-header affordances (audit #3, #19)", () => {
  it("spawn (+) and remove (trash) buttons are focusable — not display:none — and expose their aria-labels", () => {
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
    // Kept in the layout + tab order (opacity-based reveal), not display:none.
    expect(spawnBtn.className).not.toMatch(/\bhidden\b/);
    expect(removeBtn.className).not.toMatch(/\bhidden\b/);
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
