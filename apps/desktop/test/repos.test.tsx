import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { RepoModal } from "../src/renderer/components/RepoModal.js";
import { RepoTree } from "../src/renderer/views/RepoTree.js";
import type { FleetRow } from "../src/renderer/store/reduce.js";

describe("RepoModal", () => {
  it("registers a new repo from the form", () => {
    const onRegister = vi.fn();
    const onClose = vi.fn();
    render(<RepoModal repos={[]} onRegister={onRegister} onClose={onClose} />);
    fireEvent.change(screen.getByPlaceholderText("my-service"), { target: { value: "ops" } });
    fireEvent.change(screen.getByPlaceholderText("/Users/you/project"), { target: { value: "/o" } });
    fireEvent.change(screen.getByPlaceholderText("이 레포가 하는 일"), { target: { value: "운영" } });
    fireEvent.click(screen.getByText("등록"));
    expect(onRegister).toHaveBeenCalledWith({ name: "ops", path: "/o", description: "운영" });
  });
});

describe("RepoTree", () => {
  it("right-click sub → rename/stop/archive/delete; stop only for running/idle; archived subs go to the archive", () => {
    const onArchiveSub = vi.fn();
    const onDeleteSub = vi.fn();
    const onStopSub = vi.fn();
    const repos = [{ name: "app", path: "/p", description: "결제", base: null }];
    const fleet: FleetRow[] = [
      { id: "a1", label: "live-sub", repoPath: "/p", status: "idle", branch: "rookery/a1", model: null, permissionMode: "bypassPermissions" },
      { id: "a2", label: "arch-sub", repoPath: "/p", status: "stopped", branch: "rookery/a2", model: null, permissionMode: "bypassPermissions", archived: true },
    ];
    render(<RepoTree repos={repos} fleet={fleet} activeSubId={null} onSelectSub={() => {}} onNewRepo={() => {}} onRemoveRepo={() => {}} onNewSub={() => {}} onStopSub={onStopSub} onArchiveSub={onArchiveSub} onDeleteSub={onDeleteSub} onRenameSub={vi.fn()} />);
    expect(screen.getByText("live-sub")).toBeInTheDocument();
    expect(screen.queryByText("arch-sub")).toBeNull(); // archive collapsed → hidden
    fireEvent.click(screen.getByText(/보관함/));
    expect(screen.getByText("arch-sub")).toBeInTheDocument(); // visible when expanded
    // right-click idle worker → stop shows
    fireEvent.contextMenu(screen.getByText("live-sub"));
    fireEvent.click(screen.getByText("중단"));
    expect(onStopSub).toHaveBeenCalledWith("a1");
    // right-click stopped (archived) worker → no stop
    fireEvent.contextMenu(screen.getByText("arch-sub"));
    expect(screen.queryByText("중단")).toBeNull();
    fireEvent.contextMenu(screen.getByText("live-sub"));
    fireEvent.click(screen.getByText("보관"));
    expect(onArchiveSub).toHaveBeenCalledWith("a1", true);
    fireEvent.contextMenu(screen.getByText("live-sub"));
    fireEvent.click(screen.getByText("삭제…"));
    expect(screen.getByText("워커 삭제")).toBeInTheDocument();
    fireEvent.click(screen.getByText("삭제"));
    expect(onDeleteSub).toHaveBeenCalledWith("a1");
  });

  it("shows an unread dot for attention subs, but not for the active (currently viewing) one", () => {
    const repos = [{ name: "app", path: "/p", description: "결제", base: null }];
    const fleet: FleetRow[] = [
      { id: "a1", label: "done-sub", repoPath: "/p", status: "idle", branch: "rookery/a1", model: null, permissionMode: "bypassPermissions" },
      { id: "a2", label: "seen-sub", repoPath: "/p", status: "idle", branch: "rookery/a2", model: null, permissionMode: "bypassPermissions" },
    ];
    render(<RepoTree repos={repos} fleet={fleet} activeSubId={"a2"} attention={{ a1: true, a2: true }} onSelectSub={() => {}} onNewRepo={() => {}} onRemoveRepo={() => {}} onNewSub={() => {}} />);
    expect(screen.getAllByTitle(/새 변화/)).toHaveLength(1); // only a1 (a2 excluded since it's active)
  });

  it("lists repos with their workers and selects a worker", () => {
    const onSelectSub = vi.fn();
    const repos = [{ name: "app", path: "/p", description: "결제", base: null }];
    const fleet: FleetRow[] = [{ id: "a1", label: "create-hello", repoPath: "/p", status: "running", branch: "rookery/a1", model: null, permissionMode: "bypassPermissions" }];
    render(<RepoTree repos={repos} fleet={fleet} activeSubId={null} onSelectSub={onSelectSub} onNewRepo={() => {}} onRemoveRepo={() => {}} onNewSub={() => {}} />);
    expect(screen.getByText("app")).toBeInTheDocument();
    expect(screen.getByText("create-hello")).toBeInTheDocument();
    fireEvent.click(screen.getByText("create-hello"));
    expect(onSelectSub).toHaveBeenCalledWith("a1");
  });

  it("filters workers by label once the fleet is large (search toolbar)", () => {
    const repos = [{ name: "app", path: "/p", description: "결제", base: null }];
    const fleet: FleetRow[] = Array.from({ length: 6 }, (_, i) => ({
      id: `w${i}`, label: i === 0 ? "alpha-fix" : `beta-${i}`, repoPath: "/p", status: "idle", branch: null, model: null, permissionMode: "bypassPermissions",
    }));
    render(<RepoTree repos={repos} fleet={fleet} activeSubId={null} onSelectSub={() => {}} onNewRepo={() => {}} onRemoveRepo={() => {}} onNewSub={() => {}} />);
    expect(screen.getByText("alpha-fix")).toBeInTheDocument();
    expect(screen.getByText("beta-1")).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/워커 필터/), { target: { value: "alpha" } });
    expect(screen.getByText("alpha-fix")).toBeInTheDocument();
    expect(screen.queryByText("beta-1")).toBeNull(); // filtered out
  });

  it("shows a provisioning worker with the PREP tag (worktree being created)", () => {
    const repos = [{ name: "app", path: "/p", description: "결제", base: null }];
    const fleet: FleetRow[] = [{ id: "a1", label: "spawning-sub", repoPath: "/p", status: "provisioning", branch: "rookery/a1", model: null, permissionMode: "bypassPermissions" }];
    render(<RepoTree repos={repos} fleet={fleet} activeSubId={null} onSelectSub={() => {}} onNewRepo={() => {}} onRemoveRepo={() => {}} onNewSub={() => {}} />);
    expect(screen.getByText("spawning-sub")).toBeInTheDocument();
    expect(screen.getByText("PREP")).toBeInTheDocument(); // statusTag(provisioning)
  });

  it("groups workers of unregistered repos under Other and fires New repo", () => {
    const onNewRepo = vi.fn();
    const fleet: FleetRow[] = [{ id: "x9", label: "orphan", repoPath: "/tmp/raw", status: "running", branch: null, model: null, permissionMode: "bypassPermissions" }];
    render(<RepoTree repos={[]} fleet={fleet} activeSubId={null} onSelectSub={() => {}} onNewRepo={onNewRepo} onRemoveRepo={() => {}} onNewSub={() => {}} />);
    expect(screen.getByText(/기타/)).toBeInTheDocument();
    expect(screen.getByText("orphan")).toBeInTheDocument();
    fireEvent.click(screen.getByText(/새 레포/));
    expect(onNewRepo).toHaveBeenCalled();
  });

  it("loadFailed && !loaded → shows an error row (not the empty copy) with a retry button that re-fires fleet.list (audit #14)", () => {
    const onRetry = vi.fn();
    render(<RepoTree repos={[]} fleet={[]} activeSubId={null} onSelectSub={() => {}} onNewRepo={() => {}} onRemoveRepo={() => {}} onNewSub={() => {}} loaded={false} loadFailed={true} onRetry={onRetry} />);
    expect(screen.getByText("목록을 불러오지 못했어요")).toBeInTheDocument();
    expect(screen.queryByText(/등록된 레포가 없어요/)).toBeNull();
    fireEvent.click(screen.getByText("다시 시도"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
