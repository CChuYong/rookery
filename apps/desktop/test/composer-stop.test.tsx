import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { Composer } from "../src/renderer/components/Composer.js";

describe("Composer stop-button feedback", () => {
  it("clicking Stop shows a disabled spinner (no double-fire, no 'ignored' look) until the turn ends", () => {
    const onStop = vi.fn();
    const { rerender } = render(<Composer onSend={() => {}} onStop={onStop} busy controls={{ model: "claude-opus-4-8", editable: false }} />);
    const stop = screen.getByRole("button", { name: /중단|Stop/ });
    expect(stop).not.toBeDisabled();

    fireEvent.click(stop);
    expect(onStop).toHaveBeenCalledTimes(1);
    // now "stopping": the same button is disabled (blocks a second fire) and shows a spinner
    expect(screen.getByRole("button", { name: /중단|Stop/ })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /중단|Stop/ }));
    expect(onStop).toHaveBeenCalledTimes(1); // disabled → re-click is a no-op

    // turn actually ends (busy=false) → stop swaps back to send, and the stopping flag resets
    rerender(<Composer onSend={() => {}} onStop={onStop} busy={false} controls={{ model: "claude-opus-4-8", editable: false }} />);
    expect(screen.queryByRole("button", { name: /중단|Stop/ })).toBeNull();
  });
});

// Escalation: a soft interrupt can't stop a worker wedged in a long tool call / Dynamic Workflow, so the Stop
// spinner would spin forever. After a timeout with the worker still busy, reveal a "Recover" affordance
// (worker.recover) — but only when onRecover is provided (workers), never for a master.
describe("Composer stuck-stop → Recover escalation", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  const props = { onSend: () => {}, controls: { model: "claude-opus-4-8", editable: false } };

  it("reveals a Recover button when Stop doesn't settle in time, and clicking it calls onRecover", () => {
    const onStop = vi.fn();
    const onRecover = vi.fn();
    render(<Composer {...props} onStop={onStop} onRecover={onRecover} busy />);
    fireEvent.click(screen.getByRole("button", { name: /중단|Stop/ }));
    expect(onStop).toHaveBeenCalledTimes(1);
    // before the timeout: still just the disabled stop spinner, no recover yet
    expect(screen.queryByRole("button", { name: /복구|Recover/ })).toBeNull();
    act(() => { vi.advanceTimersByTime(7000); }); // still busy after the stuck threshold
    const recover = screen.getByRole("button", { name: /복구|Recover/ });
    expect(recover).not.toBeDisabled();
    fireEvent.click(recover);
    expect(onRecover).toHaveBeenCalledTimes(1);
  });

  it("does NOT reveal Recover for a master (no onRecover) even after the timeout", () => {
    render(<Composer {...props} onStop={() => {}} busy />);
    fireEvent.click(screen.getByRole("button", { name: /중단|Stop/ }));
    act(() => { vi.advanceTimersByTime(7000); });
    expect(screen.queryByRole("button", { name: /복구|Recover/ })).toBeNull();
  });

  it("resets — a Recover shown then the turn ends (busy=false) clears the escalation for the next turn", () => {
    const onRecover = vi.fn();
    const { rerender } = render(<Composer {...props} onStop={() => {}} onRecover={onRecover} busy />);
    fireEvent.click(screen.getByRole("button", { name: /중단|Stop/ }));
    act(() => { vi.advanceTimersByTime(7000); });
    expect(screen.getByRole("button", { name: /복구|Recover/ })).toBeInTheDocument();
    // recover succeeds → worker returns to idle → busy=false: the escalation button is gone
    rerender(<Composer {...props} onStop={() => {}} onRecover={onRecover} busy={false} />);
    expect(screen.queryByRole("button", { name: /복구|Recover/ })).toBeNull();
  });
});
