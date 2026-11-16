import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { LoadFailed, EmptyState } from "../src/renderer/ui/load-state.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("LoadFailed", () => {
  it("shows the message and a retry button that calls onRetry", () => {
    const onRetry = vi.fn();
    render(<LoadFailed message="목록을 불러오지 못했어요" onRetry={onRetry} />);
    expect(screen.getByText("목록을 불러오지 못했어요")).toBeInTheDocument();
    fireEvent.click(screen.getByText("다시 시도"));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("a promise-returning retry shows progress while pending and the failure once it rejects", async () => {
    const d = deferred();
    render(<LoadFailed message="실패" onRetry={() => d.promise} />);
    const btn = screen.getByRole("button", { name: "다시 시도" });
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-busy", "true");
    expect(btn).toBeDisabled();
    await act(async () => { d.reject(new Error("daemon offline")); await d.promise.catch(() => {}); });
    expect(btn).not.toHaveAttribute("aria-busy");
    expect(screen.getByText(/다시 시도했지만 실패했어요/)).toBeInTheDocument();
    expect(screen.getByText(/daemon offline/)).toBeInTheDocument();
  });

  it("an external retrying flag also marks the button busy", () => {
    render(<LoadFailed message="실패" onRetry={() => {}} retrying />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-busy", "true");
  });

  it("renders a caller-supplied detail line", () => {
    render(<LoadFailed message="실패" detail="boom" onRetry={() => {}} />);
    expect(screen.getByText("boom")).toBeInTheDocument();
  });
});

describe("EmptyState", () => {
  it("one muted line plus an optional text action", () => {
    const onClick = vi.fn();
    render(<EmptyState action={{ label: "추가", onClick }}>아무것도 없어요</EmptyState>);
    expect(screen.getByText("아무것도 없어요")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "추가" }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});
