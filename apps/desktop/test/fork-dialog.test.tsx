import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ForkDialog } from "../src/renderer/components/ForkDialog.js";
import { useStore } from "../src/renderer/store/store.js";

// useT falls back to ko when no I18nProvider is mounted → the labels below are the ko strings.
describe("ForkDialog", () => {
  beforeEach(() => {
    // Reset the singleton store slots this dialog reads.
    useStore.setState({ codexModels: null });
    useStore.getState().setCodexAuthStatus(null);
  });

  it("defaults the target provider to the OTHER provider and forks with the chosen target", () => {
    // Codex ready → the Fork button is enabled so the click actually reaches onFork.
    useStore.getState().setCodexAuthStatus({ method: "chatgpt", ready: true, hint: null });
    const onFork = vi.fn();
    render(<ForkDialog kind="master" sourceProvider="claude" onFork={onFork} onClose={() => {}} />);
    // target defaults to codex (the other provider)
    fireEvent.click(screen.getByRole("button", { name: /fork|포크/i }));
    expect(onFork).toHaveBeenCalledWith(expect.objectContaining({ provider: "codex" }));
  });

  it("defaults to claude when the source is codex (no auth gate for claude) and forks with provider claude", () => {
    const onFork = vi.fn();
    render(<ForkDialog kind="worker" sourceProvider="codex" onFork={onFork} onClose={() => {}} />);
    const btn = screen.getByRole("button", { name: /fork|포크/i });
    expect(btn).not.toBeDisabled();
    fireEvent.click(btn);
    expect(onFork).toHaveBeenCalledWith(expect.objectContaining({ provider: "claude" }));
  });

  it("disables Fork and warns when target=codex is not authenticated (auth-probe gate)", () => {
    useStore.getState().setCodexAuthStatus({ method: "none", ready: false, hint: null });
    render(<ForkDialog kind="master" sourceProvider="claude" onFork={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/codex.*(인증|auth)/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /fork|포크/i })).toBeDisabled();
  });

  it("also gates when the codex probe is still null (unknown) or unavailable", () => {
    // null (still probing) → gated
    const { rerender } = render(<ForkDialog kind="master" sourceProvider="claude" onFork={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /fork|포크/i })).toBeDisabled();
    // "unavailable" (probe couldn't run) → gated
    useStore.getState().setCodexAuthStatus("unavailable");
    rerender(<ForkDialog kind="master" sourceProvider="claude" onFork={() => {}} onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /fork|포크/i })).toBeDisabled();
  });

  it("Esc triggers onClose", async () => {
    // onClose is deferred behind the exit animation (useDismissTransition), so poll for it.
    useStore.getState().setCodexAuthStatus({ method: "chatgpt", ready: true, hint: null });
    const onClose = vi.fn();
    render(<ForkDialog kind="master" sourceProvider="claude" onFork={() => {}} onClose={onClose} />);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });
});
