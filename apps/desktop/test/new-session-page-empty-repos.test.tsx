import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NewSessionPage } from "../src/renderer/components/NewSessionPage.js";

// Audit #58: repos.length === 0 used to hide the whole repo-picker area, leaving a blank space below the
// composer with no hint that registering a repo is the prerequisite for spawning workers.
describe("NewSessionPage empty-repo CTA (audit #58)", () => {
  it("renders a register-repo CTA in place of the (hidden) repo picker when there are no repos", () => {
    const onRegisterRepo = vi.fn();
    render(<NewSessionPage repos={[]} defaultModel="claude-opus-4-8" defaultEffort="high" onStart={() => {}} onRegisterRepo={onRegisterRepo} />);
    expect(screen.getByText("아직 등록된 레포가 없어요")).toBeInTheDocument();
    fireEvent.click(screen.getByText("레포 등록…"));
    expect(onRegisterRepo).toHaveBeenCalledTimes(1);
  });

  it("renders nothing in that slot when there are no repos and no onRegisterRepo handler (back-compat)", () => {
    render(<NewSessionPage repos={[]} defaultModel="claude-opus-4-8" defaultEffort="high" onStart={() => {}} />);
    expect(screen.queryByText("아직 등록된 레포가 없어요")).toBeNull();
  });

  it("shows the normal repo picker instead of the CTA once repos exist", () => {
    const onRegisterRepo = vi.fn();
    render(<NewSessionPage repos={[{ name: "proj", path: "/code/proj" }]} defaultModel="claude-opus-4-8" defaultEffort="high" onStart={() => {}} onRegisterRepo={onRegisterRepo} />);
    expect(screen.getByText("proj")).toBeInTheDocument();
    expect(screen.queryByText("아직 등록된 레포가 없어요")).toBeNull();
  });
});
