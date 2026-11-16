import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ReposHome } from "../src/renderer/components/ReposHome.js";

// audit #23: with no worker selected the Repos main area was a header-less void with three grey lines describing a
// "+ button on a repo header". It now keeps a header and offers the action directly.
describe("ReposHome (audit #23)", () => {
  it("has a Repos header with a New worker action and a one-line hint", () => {
    const onNewWorker = vi.fn();
    render(<ReposHome hasRepos onNewWorker={onNewWorker} onNewRepo={() => {}} />);
    expect(screen.getByRole("heading", { name: "레포" })).toBeInTheDocument();
    const actions = screen.getAllByRole("button", { name: "새 워커" });
    expect(actions.length).toBeGreaterThan(0);
    fireEvent.click(actions[0]!);
    expect(onNewWorker).toHaveBeenCalledTimes(1);
    expect(screen.getByText("왼쪽에서 워커를 고르거나 새 워커를 스폰하세요.")).toBeInTheDocument();
  });

  it("offers registering a repo when there is none", () => {
    const onNewRepo = vi.fn();
    render(<ReposHome hasRepos={false} onNewWorker={() => {}} onNewRepo={onNewRepo} />);
    expect(screen.queryByRole("button", { name: "새 워커" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "새 레포" }));
    expect(onNewRepo).toHaveBeenCalledTimes(1);
  });

  // Final review #12 (#89): a failed repos.list shows the failure with a retry, not a blank area forever.
  it("shows a load failure with a retry while the repo list hasn't arrived", () => {
    const onRetry = vi.fn(() => Promise.resolve());
    render(<ReposHome hasRepos={false} loaded={false} loadFailed onRetry={onRetry} onNewWorker={() => {}} onNewRepo={() => {}} />);
    expect(screen.getByText("레포 목록을 불러오지 못했어요")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "새 레포" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "다시 시도" }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
