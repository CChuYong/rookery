import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { OnboardingModal } from "../src/renderer/components/OnboardingModal.js";

describe("OnboardingModal", () => {
  it("(a) has role=dialog + aria-modal + aria-labelledby for a11y (audit #25)", () => {
    render(<OnboardingModal onFinish={() => Promise.resolve()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby");
  });

  it("(b) autofocuses the Next button on step 0 (audit #25)", () => {
    render(<OnboardingModal onFinish={() => Promise.resolve()} />);
    // ko fallback: "다음"
    expect(screen.getByRole("button", { name: /다음/ })).toHaveFocus();
  });

  it("(c) Escape calls onFinish (Skip)", () => {
    const onFinish = vi.fn(() => Promise.resolve());
    render(<OnboardingModal onFinish={onFinish} />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("(d) a rejecting onFinish (Skip) shows the inline error and re-enables the button (audit #7)", async () => {
    const onFinish = vi.fn(() => Promise.reject(new Error("boom")));
    render(<OnboardingModal onFinish={onFinish} />);
    const skip = screen.getByRole("button", { name: "건너뛰기" });
    fireEvent.click(skip);
    await screen.findByText("저장하지 못했어요 — 다시 시도해주세요.");
    expect(skip).not.toBeDisabled();
  });

  it("(f) the concept step introduces the Backends (Claude/Codex) concept (interop QW4)", () => {
    render(<OnboardingModal onFinish={() => Promise.resolve()} />);
    fireEvent.click(screen.getByRole("button", { name: /다음/ })); // advance to the concept step
    expect(screen.getByText("백엔드")).toBeInTheDocument(); // onboarding.backends (ko)
  });

  it("(e) a rejecting onFinish (Get started) shows the inline error and re-enables the button (audit #7)", async () => {
    const onFinish = vi.fn(() => Promise.reject(new Error("boom")));
    render(<OnboardingModal onFinish={onFinish} />);
    fireEvent.click(screen.getByRole("button", { name: /다음/ })); // advance to the concept step
    const getStarted = screen.getByRole("button", { name: "시작하기" });
    fireEvent.click(getStarted);
    await screen.findByText("저장하지 못했어요 — 다시 시도해주세요.");
    expect(getStarted).not.toBeDisabled();
    expect(onFinish).toHaveBeenCalledTimes(1);
  });
});
