import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsPage } from "../src/renderer/components/SettingsPage.js";

const base = {
  settings: { masterName: "rookery", masterModel: "m", workerModel: "w", masterEffort: "high", workerEffort: "high", slackCwd: "/work", slackAllowedUsers: "", slackAllowAll: "0", slackRefuseReply: "1", slackRefusalMessage: "x", slackLocale: "ko", usageRefreshMs: "120000", hasAcceptedDataNotice: "0", onboardingDone: "0", defaultSessionCwd: "", workerSlackRelayEnabled: "0", workerSlackRelayChannel: "" },
  onSave: () => {},
  onClose: () => {},
  slack: "off" as const,
  onSlackToggle: () => {},
};

describe("SettingsPage Claude tab", () => {
  it("shows the active auth method + masked key (API key)", () => {
    render(<SettingsPage {...base} authStatus={{ method: "api-key", apiKeyPresent: true, apiKeyHint: "sk-ant-a…1234", oauthPresent: false, overridesSubscription: false }} />);
    fireEvent.click(screen.getByText("Claude")); // switch to the Claude tab
    expect(screen.getByText("API 키")).toBeInTheDocument(); // ko fallback method label
    expect(screen.getByText("sk-ant-a…1234")).toBeInTheDocument();
    expect(screen.queryByText(/ANTHROPIC_API_KEY가 우선/)).toBeNull(); // no override (no subscription present)
  });

  it("shows the subscription method when only OAuth is present", () => {
    render(<SettingsPage {...base} authStatus={{ method: "oauth", apiKeyPresent: false, apiKeyHint: null, oauthPresent: true, overridesSubscription: false }} />);
    fireEvent.click(screen.getByText("Claude"));
    expect(screen.getByText("Claude 구독")).toBeInTheDocument();
  });

  it("warns when an API key silently overrides the subscription", () => {
    render(<SettingsPage {...base} authStatus={{ method: "api-key", apiKeyPresent: true, apiKeyHint: "sk…", oauthPresent: true, overridesSubscription: true }} />);
    fireEvent.click(screen.getByText("Claude"));
    expect(screen.getByText(/ANTHROPIC_API_KEY가 우선/)).toBeInTheDocument(); // surprise-billing warning
  });
});
