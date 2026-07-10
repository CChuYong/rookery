import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsPage } from "../src/renderer/components/SettingsPage.js";

// useT falls back to ko when no I18nProvider is mounted, so labels below are the ko strings.
const base = {
  settings: { masterName: "rookery", masterModel: "m", workerModel: "w", masterEffort: "high", workerEffort: "high", slackCwd: "/work", slackAllowedUsers: "", slackAllowAll: "0", slackRefuseReply: "1", slackRefusalMessage: "x", slackLocale: "ko", usageRefreshMs: "120000", hasAcceptedDataNotice: "0", onboardingDone: "0", defaultSessionCwd: "", workerSlackRelayEnabled: "0", workerSlackRelayChannel: "", codexWorkerModel: "gpt-5.5", codexMasterModel: "gpt-5.5", codexBin: "codex", codexTurnIdleTimeoutMs: "0", codexHandshakeTimeoutMs: "30000", slackProvider: "claude", workerCostBudgetUsd: "", mcpExposure: "off" },
  onSave: () => {},
  onClose: () => {},
  slack: "off" as const,
  onSlackToggle: () => {},
};

describe("SettingsPage — unified Models tab (Claude/Codex)", () => {
  it("has a single 'Models' top-level tab; Claude/Codex are no longer top-level tabs", () => {
    render(<SettingsPage {...base} authStatus={null} />);
    expect(screen.getByText("모델")).toBeInTheDocument(); // the umbrella tab
    // Codex/Claude live INSIDE Models (a pill sub-toggle), hidden until Models is opened.
    expect(screen.queryByText("Codex")).toBeNull();
  });

  it("Models tab defaults to the Claude sub-tab (Anthropic API key visible)", () => {
    render(<SettingsPage {...base} authStatus={{ method: "none", apiKeyPresent: false, apiKeyHint: null, oauthPresent: false, overridesSubscription: false }} />);
    fireEvent.click(screen.getByText("모델"));
    expect(screen.getByPlaceholderText("sk-ant-…")).toBeInTheDocument();
  });

  it("the pill sub-toggle switches to Codex config", () => {
    render(<SettingsPage {...base} authStatus={null} />);
    fireEvent.click(screen.getByText("모델"));
    fireEvent.click(screen.getByText("Codex")); // the pill (now rendered)
    expect(screen.getByPlaceholderText("codex")).toBeInTheDocument(); // codexBin field
  });

  it("moves the Claude worker-model default out of General into the Claude sub-tab", () => {
    render(<SettingsPage {...base} authStatus={null} />);
    // General is the default tab → no worker-model heading there anymore
    expect(screen.queryByText("워커 기본 모델 / 강도")).toBeNull();
    fireEvent.click(screen.getByText("모델")); // Claude sub-tab is the default
    expect(screen.getByText("워커 기본 모델 / 강도")).toBeInTheDocument();
  });

  it("keeps the provider-agnostic worker cost budget in General", () => {
    render(<SettingsPage {...base} authStatus={null} />);
    expect(screen.getByText("워커 비용 예산")).toBeInTheDocument(); // new workerBudget section, still in General
  });
});
