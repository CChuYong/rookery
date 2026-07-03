import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DataConsentModal } from "../src/renderer/components/DataConsentModal.js";
import type { SettingsValues } from "@daemon/core/settings.js";

const baseSettings: SettingsValues = {
  masterName: "rookery",
  masterModel: "claude-opus-4-8",
  workerModel: "claude-opus-4-8",
  masterEffort: "high",
  workerEffort: "high",
  slackCwd: "/work",
  slackAllowedUsers: "",
  slackAllowAll: "0",
  slackRefuseReply: "1",
  slackRefusalMessage: "",
  slackLocale: "ko",
  usageRefreshMs: "120000",
  hasAcceptedDataNotice: "0",
  onboardingDone: "0",
  defaultSessionCwd: "",
  workerSlackRelayEnabled: "0",
  workerSlackRelayChannel: "",
};

describe("DataConsentModal", () => {
  it("(a) shows modal when daemon is up and hasAcceptedDataNotice is 0", () => {
    render(<DataConsentModal settings={baseSettings} daemon="up" onAccept={() => Promise.resolve()} />);
    expect(screen.getByText(/Anthropic/)).toBeInTheDocument();
    // ko fallback: "동의하고 계속"
    expect(screen.getByRole("button", { name: /동의하고 계속/ })).toBeInTheDocument();
  });

  it("(b) does not show modal when hasAcceptedDataNotice is 1", () => {
    const accepted = { ...baseSettings, hasAcceptedDataNotice: "1" };
    const { container } = render(<DataConsentModal settings={accepted} daemon="up" onAccept={() => Promise.resolve()} />);
    expect(container.firstChild).toBeNull();
  });

  it("(c) does not show modal when settings is null (flash prevention)", () => {
    const { container } = render(<DataConsentModal settings={null} daemon="up" onAccept={() => Promise.resolve()} />);
    expect(container.firstChild).toBeNull();
  });

  it("(c2) does not show modal when daemon is not up", () => {
    const { container } = render(<DataConsentModal settings={baseSettings} daemon="down" onAccept={() => Promise.resolve()} />);
    expect(container.firstChild).toBeNull();
  });

  it("(d) calls onAccept when Accept button is clicked", () => {
    const onAccept = vi.fn(() => Promise.resolve());
    render(<DataConsentModal settings={baseSettings} daemon="up" onAccept={onAccept} />);
    fireEvent.click(screen.getByRole("button", { name: /동의하고 계속/ }));
    expect(onAccept).toHaveBeenCalledTimes(1);
  });

  it("(e) has role=dialog + aria-modal for a11y (audit #26)", () => {
    render(<DataConsentModal settings={baseSettings} daemon="up" onAccept={() => Promise.resolve()} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-labelledby");
  });

  it("(f) autofocuses the Accept button on mount (audit #26)", () => {
    render(<DataConsentModal settings={baseSettings} daemon="up" onAccept={() => Promise.resolve()} />);
    expect(screen.getByRole("button", { name: /동의하고 계속/ })).toHaveFocus();
  });

  it("(g) a rejecting onAccept shows the inline error and re-enables the button (audit #7)", async () => {
    const onAccept = vi.fn(() => Promise.reject(new Error("boom")));
    render(<DataConsentModal settings={baseSettings} daemon="up" onAccept={onAccept} />);
    const button = screen.getByRole("button", { name: /동의하고 계속/ });
    fireEvent.click(button);
    await screen.findByText("저장하지 못했어요 — 다시 시도해주세요.");
    expect(button).not.toBeDisabled();
  });
});
