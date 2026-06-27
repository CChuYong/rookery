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
};

describe("DataConsentModal", () => {
  it("(a) shows modal when daemon is up and hasAcceptedDataNotice is 0", () => {
    render(<DataConsentModal settings={baseSettings} daemon="up" onAccept={() => {}} />);
    expect(screen.getByText(/Anthropic/)).toBeInTheDocument();
    // ko fallback: "동의하고 계속"
    expect(screen.getByRole("button", { name: /동의하고 계속/ })).toBeInTheDocument();
  });

  it("(b) does not show modal when hasAcceptedDataNotice is 1", () => {
    const accepted = { ...baseSettings, hasAcceptedDataNotice: "1" };
    const { container } = render(<DataConsentModal settings={accepted} daemon="up" onAccept={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("(c) does not show modal when settings is null (flash prevention)", () => {
    const { container } = render(<DataConsentModal settings={null} daemon="up" onAccept={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("(c2) does not show modal when daemon is not up", () => {
    const { container } = render(<DataConsentModal settings={baseSettings} daemon="down" onAccept={() => {}} />);
    expect(container.firstChild).toBeNull();
  });

  it("(d) calls onAccept when Accept button is clicked", () => {
    const onAccept = vi.fn();
    render(<DataConsentModal settings={baseSettings} daemon="up" onAccept={onAccept} />);
    fireEvent.click(screen.getByRole("button", { name: /동의하고 계속/ }));
    expect(onAccept).toHaveBeenCalledTimes(1);
  });
});
