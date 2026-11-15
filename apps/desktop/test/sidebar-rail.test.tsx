import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SidebarRail } from "../src/renderer/components/SidebarRail.js";

const base = {
  onExpand: () => {}, onBack: () => {}, onForward: () => {}, canBack: true, canFwd: false,
  view: "sessions" as const, sessionsUnread: false, reposUnread: false,
  onSessions: () => {}, onRepos: () => {}, onNew: () => {}, newLabel: "새 세션", newActive: false,
};

// audit #19: the collapsed rail repeated the status bar (resources, notifications, restart, bell, capabilities,
// automation, settings) and had no way to switch Sessions/Repos or start something new. It is a navigation rail now.
describe("SidebarRail (audit #19)", () => {
  it("offers expand, back/forward, Sessions, Repos and the new-item entry — nothing the status bar already has", () => {
    render(<SidebarRail {...base} />);
    const names = screen.getAllByRole("button").map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual(["사이드바 펼치기", "뒤로", "앞으로", "세션", "레포", "새 세션"]);
    for (const gone of ["데몬 재시작", "설정", "자동화", "Capability Center"]) expect(screen.queryByLabelText(gone)).toBeNull();
  });

  it("marks the current view and shows an unread dot on the other one", () => {
    render(<SidebarRail {...base} reposUnread />);
    expect(screen.getByLabelText("세션")).toHaveAttribute("aria-current", "page");
    expect(screen.getByLabelText("레포")).not.toHaveAttribute("aria-current");
    expect(screen.getByLabelText("레포").querySelector("[data-unread]")).not.toBeNull();
    expect(screen.getByLabelText("세션").querySelector("[data-unread]")).toBeNull();
  });

  it("wires each entry to its handler and disables back/forward without history", () => {
    const onRepos = vi.fn(); const onNew = vi.fn(); const onExpand = vi.fn();
    render(<SidebarRail {...base} onRepos={onRepos} onNew={onNew} onExpand={onExpand} />);
    fireEvent.click(screen.getByLabelText("레포"));
    fireEvent.click(screen.getByLabelText("새 세션"));
    fireEvent.click(screen.getByLabelText("사이드바 펼치기"));
    expect(onRepos).toHaveBeenCalledTimes(1);
    expect(onNew).toHaveBeenCalledTimes(1);
    expect(onExpand).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText("앞으로")).toBeDisabled();
    expect(screen.getByLabelText("뒤로")).not.toBeDisabled();
  });
});
