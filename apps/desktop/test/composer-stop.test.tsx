import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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
