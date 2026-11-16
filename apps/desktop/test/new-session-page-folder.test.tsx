import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { NewSessionPage } from "../src/renderer/components/NewSessionPage.js";

// Audit #87: one working-folder control — the registered repos are the first group of the folder menu, next to the
// OS folder dialog — instead of a folder chip in the box plus a second repo row under it.
describe("NewSessionPage folder menu", () => {
  it("lists registered repos inside the folder menu and picks one", () => {
    const onStart = vi.fn();
    render(<NewSessionPage repos={[{ name: "app", path: "/code/app" }]} defaultModel="claude-opus-4-8" defaultEffort="high" onStart={onStart} />);
    fireEvent.click(screen.getByRole("button", { name: /작업 폴더/ }));
    const menu = screen.getByRole("dialog", { name: /작업 폴더/ });
    expect(within(menu).getByText(/등록된 레포/)).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: /폴더 선택…/ })).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("button", { name: "app" }));
    expect(screen.queryByRole("dialog", { name: /작업 폴더/ })).toBeNull();
    fireEvent.click(screen.getByLabelText("시작"));
    expect(onStart).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/code/app" }));
  });

  // Final review #12 (#89): a failed repos.list is said in the folder menu, with a retry, instead of an empty group.
  it("says when the repo list failed and retries from the folder menu", () => {
    const onRetryRepos = vi.fn(() => Promise.resolve());
    render(<NewSessionPage repos={[]} reposLoaded={false} reposLoadFailed onRetryRepos={onRetryRepos} defaultModel="claude-opus-4-8" defaultEffort="high" onStart={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /작업 폴더/ }));
    const menu = screen.getByRole("dialog", { name: /작업 폴더/ });
    expect(within(menu).getByText("레포 목록을 불러오지 못했어요")).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole("button", { name: "다시 시도" }));
    expect(onRetryRepos).toHaveBeenCalledTimes(1);
    expect(within(menu).getByRole("button", { name: /폴더 선택…/ })).toBeInTheDocument(); // the OS dialog still works
  });

  it("puts provider, model, effort and speed into the composer's model menu", () => {
    render(<NewSessionPage repos={[]} defaultModel="claude-opus-4-8" defaultEffort="high" onStart={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /Opus 4\.8 · 높음/ }));
    const menu = screen.getByRole("dialog");
    expect(menu).toContainElement(screen.getByTitle("백엔드"));
    expect(menu).toContainElement(screen.getByRole("combobox", { name: "속도" }));
  });
});
