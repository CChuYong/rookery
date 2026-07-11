import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { GettingStartedChecklist } from "../src/renderer/components/GettingStartedChecklist.js";

// The checklist guides a new user all the way to the product's "wow" moment (first worker spawn),
// not just to the first session — the 4th item auto-completes from live fleet state.

const noop = (): void => {};
function renderChecklist(over: Partial<Parameters<typeof GettingStartedChecklist>[0]> = {}) {
  return render(
    <GettingStartedChecklist
      authDone={false} folderDone={false} sessionDone={false} workerDone={false}
      onAuth={noop} onFolder={noop} onSession={noop} onWorker={noop} onDismiss={noop}
      {...over}
    />,
  );
}

describe("GettingStartedChecklist", () => {
  it("renders 4 items including the first-worker step, with a 0/4 counter", () => {
    renderChecklist();
    // ko fallback catalog
    expect(screen.getByText("첫 워커 스폰")).toBeInTheDocument();
    expect(screen.getByText("0/4")).toBeInTheDocument();
  });

  it("clicking the worker action fires onWorker", () => {
    const onWorker = vi.fn();
    renderChecklist({ onWorker });
    fireEvent.click(screen.getByRole("button", { name: /예시 넣기/ }));
    expect(onWorker).toHaveBeenCalledTimes(1);
  });

  it("workerDone hides the action button and counts toward the total", () => {
    renderChecklist({ workerDone: true });
    expect(screen.queryByRole("button", { name: /예시 넣기/ })).not.toBeInTheDocument();
    expect(screen.getByText("1/4")).toBeInTheDocument();
  });
});
