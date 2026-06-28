import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsPage } from "../src/renderer/components/SettingsPage.js";

const base = {
  settings: { masterName: "rookery", masterModel: "m", workerModel: "w", masterEffort: "high", workerEffort: "high", slackCwd: "/work", slackAllowedUsers: "", slackAllowAll: "0", slackRefuseReply: "1", slackRefusalMessage: "Sorry, you're not authorized to use this bot.", slackLocale: "ko", usageRefreshMs: "120000", hasAcceptedDataNotice: "0", onboardingDone: "0", defaultSessionCwd: "" },
  onSave: () => {},
  onClose: () => {},
  slack: "off" as const,
  onSlackToggle: () => {},
};

describe("SettingsPage integrations", () => {
  it("shows GitHub status and saves a Linear key", () => {
    const onSaveLinearKey = vi.fn();
    render(<SettingsPage {...base} integrations={{ github: { available: true, user: "octo" }, linear: { configured: false } }} onSaveLinearKey={onSaveLinearKey} />);
    fireEvent.click(screen.getByText("연동")); // Switch to the Integrations tab (default is General)
    expect(screen.getByText(/octo/)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(/Linear API/i), { target: { value: "lin_xyz" } });
    fireEvent.click(screen.getByText("연결"));
    expect(onSaveLinearKey).toHaveBeenCalledWith("lin_xyz");
  });

  it("renders Slack language select and saves slackLocale", () => {
    const onSave = vi.fn();
    render(<SettingsPage {...base} onSave={onSave} />);
    fireEvent.click(screen.getByText("Slack")); // Switch to the Slack tab (default is General)
    const select = screen.getByLabelText(/Slack 언어|Slack language/);
    fireEvent.change(select, { target: { value: "en" } });
    fireEvent.click(screen.getByText("저장")); // Save button becomes enabled ("저장") once dirty
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ slackLocale: "en" }));
  });
});
