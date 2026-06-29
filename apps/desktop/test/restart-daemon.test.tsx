import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Tooltip } from "../src/renderer/components/Tooltip.js";
import { RestartDaemonDialog } from "../src/renderer/components/RestartDaemonDialog.js";

describe("Tooltip", () => {
  it("renders label in a role=tooltip node with hidden + group-hover classes", () => {
    render(
      <Tooltip label="데몬 재시작">
        <button>b</button>
      </Tooltip>,
    );
    const tip = screen.getByRole("tooltip");
    expect(tip).toBeInTheDocument();
    expect(tip.textContent).toBe("데몬 재시작");
    expect(tip.className).toMatch(/opacity-0/);
    expect(tip.className).toMatch(/group-hover:opacity-100/);
  });
});

describe("RestartDaemonDialog", () => {
  it("renders warning body + Restart/Cancel buttons", () => {
    render(
      <RestartDaemonDialog onConfirm={vi.fn()} onClose={vi.fn()} />,
    );
    // body text (ko fallback)
    expect(screen.getByText(/진행 중인 마스터 턴/)).toBeInTheDocument();
    // confirm button
    expect(screen.getByRole("button", { name: "재시작" })).toBeInTheDocument();
    // cancel button
    expect(screen.getByRole("button", { name: "취소" })).toBeInTheDocument();
  });

  it("[Restart] click → onConfirm called", () => {
    const onConfirm = vi.fn();
    render(<RestartDaemonDialog onConfirm={onConfirm} onClose={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "재시작" }));
    expect(onConfirm).toHaveBeenCalledOnce();
  });

  it("backdrop click does not close the dialog", () => {
    const onClose = vi.fn();
    render(<RestartDaemonDialog onConfirm={vi.fn()} onClose={onClose} />);
    const backdrop = screen.getByRole("button", { name: "취소" }).closest(".fixed")!;
    fireEvent.click(backdrop);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("[Cancel] click → onClose called (after exit transition)", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    render(<RestartDaemonDialog onConfirm={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByRole("button", { name: "취소" }));
    vi.advanceTimersByTime(200);
    expect(onClose).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
