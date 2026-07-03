import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DataConsentModal } from "../src/renderer/components/DataConsentModal.js";

// Visibility gating (daemon up && settings loaded && hasAcceptedDataNotice !== "1") now lives at the App.tsx mount
// site, not inside the component (review finding: an internal early-return left the panel absent on first mount,
// so useFocusTrap's `[ref]`-only effect never re-ran once it later appeared). The component itself is always
// rendered once mounted — every case below renders it directly, mirroring how the real app now mounts it.

describe("DataConsentModal", () => {
  it("(a) renders the consent panel on mount", () => {
    render(<DataConsentModal onAccept={() => Promise.resolve()} />);
    expect(screen.getByText(/Anthropic/)).toBeInTheDocument();
    // ko fallback: "동의하고 계속"
    expect(screen.getByRole("button", { name: /동의하고 계속/ })).toBeInTheDocument();
  });

  it("(d) calls onAccept when Accept button is clicked", () => {
    const onAccept = vi.fn(() => Promise.resolve());
    render(<DataConsentModal onAccept={onAccept} />);
    fireEvent.click(screen.getByRole("button", { name: /동의하고 계속/ }));
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it("(e) has role=dialog + aria-modal for a11y (audit #26)", () => {
    render(<DataConsentModal onAccept={() => Promise.resolve()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby");
  });

  it("(f) autofocuses the Accept button on mount (audit #26)", () => {
    render(<DataConsentModal onAccept={() => Promise.resolve()} />);
    expect(screen.getByRole("button", { name: /동의하고 계속/ })).toHaveFocus();
  });

  it("(g) a rejecting onAccept shows the inline error and re-enables the button (audit #7)", async () => {
    const onAccept = vi.fn(() => Promise.reject(new Error("boom")));
    render(<DataConsentModal onAccept={onAccept} />);
    const button = screen.getByRole("button", { name: /동의하고 계속/ });
    fireEvent.click(button);
    await screen.findByText("저장하지 못했어요 — 다시 시도해주세요.");
    expect(button).not.toBeDisabled();
  });

  it("(h) traps Tab focus within the panel on real first mount (task 6 review finding 1 regression)", () => {
    render(<DataConsentModal onAccept={() => Promise.resolve()} />);
    const panel = screen.getByRole("dialog");
    // The Accept button is the panel's only focusable element, so it is both first and last — pressing Tab
    // (no shift) must wrap back to it and preventDefault. If useFocusTrap's effect never attached (the bug this
    // guards against), the keydown would go unhandled and fireEvent would report it as NOT cancelled.
    expect(screen.getByRole("button", { name: /동의하고 계속/ })).toHaveFocus();
    const notCancelled = fireEvent.keyDown(panel, { key: "Tab" });
    expect(notCancelled).toBe(false); // false => preventDefault() was called, i.e. the trap intercepted it
  });
});
