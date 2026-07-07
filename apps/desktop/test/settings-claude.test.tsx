import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SettingsPage } from "../src/renderer/components/SettingsPage.js";

const base = {
  settings: { masterName: "rookery", masterModel: "m", workerModel: "w", masterEffort: "high", workerEffort: "high", slackCwd: "/work", slackAllowedUsers: "", slackAllowAll: "0", slackRefuseReply: "1", slackRefusalMessage: "x", slackLocale: "ko", usageRefreshMs: "120000", hasAcceptedDataNotice: "0", onboardingDone: "0", defaultSessionCwd: "", workerSlackRelayEnabled: "0", workerSlackRelayChannel: "", codexWorkerModel: "gpt-5.5", codexMasterModel: "gpt-5.5", codexBin: "codex", codexTurnIdleTimeoutMs: "120000", codexHandshakeTimeoutMs: "30000", slackProvider: "claude", workerCostBudgetUsd: "" },
  onSave: () => {},
  onClose: () => {},
  slack: "off" as const,
  onSlackToggle: () => {},
};

describe("SettingsPage Claude tab", () => {
  it("shows the active auth method + masked key (API key)", () => {
    render(<SettingsPage {...base} authStatus={{ method: "api-key", apiKeyPresent: true, apiKeyHint: "sk-ant-a…1234", oauthPresent: false, overridesSubscription: false }} />);
    fireEvent.click(screen.getByText("모델")); // switch to the Claude tab
    expect(screen.getByText("API 키")).toBeInTheDocument(); // ko fallback method label
    expect(screen.getByText("sk-ant-a…1234")).toBeInTheDocument();
    expect(screen.queryByText(/ANTHROPIC_API_KEY가 우선/)).toBeNull(); // no override (no subscription present)
  });

  it("shows the subscription method when only OAuth is present", () => {
    render(<SettingsPage {...base} authStatus={{ method: "oauth", apiKeyPresent: false, apiKeyHint: null, oauthPresent: true, overridesSubscription: false }} />);
    fireEvent.click(screen.getByText("모델"));
    expect(screen.getByText("Claude 구독")).toBeInTheDocument();
  });

  it("warns when an API key silently overrides the subscription", () => {
    render(<SettingsPage {...base} authStatus={{ method: "api-key", apiKeyPresent: true, apiKeyHint: "sk…", oauthPresent: true, overridesSubscription: true }} />);
    fireEvent.click(screen.getByText("모델"));
    expect(screen.getByText(/ANTHROPIC_API_KEY가 우선/)).toBeInTheDocument(); // surprise-billing warning
  });

  it("shows a neutral 'checking' state instead of 'No auth active' while authStatus is still null (audit #15)", () => {
    render(<SettingsPage {...base} authStatus={null} />);
    fireEvent.click(screen.getByText("모델"));
    expect(screen.getByText("확인 중…")).toBeInTheDocument();
    expect(screen.queryByText("인증이 감지되지 않았어요. ANTHROPIC_API_KEY를 설정하거나 터미널에서 claude login을 실행하세요.")).toBeNull();
    expect(screen.queryByText("인증 없음")).toBeNull(); // no confident "none" method label while unknown
  });

  it("keeps the 'No auth active' copy once authStatus has actually loaded as none", () => {
    render(<SettingsPage {...base} authStatus={{ method: "none", apiKeyPresent: false, apiKeyHint: null, oauthPresent: false, overridesSubscription: false }} />);
    fireEvent.click(screen.getByText("모델"));
    expect(screen.getByText("인증 없음")).toBeInTheDocument();
    expect(screen.queryByText("확인 중…")).toBeNull();
  });
});
